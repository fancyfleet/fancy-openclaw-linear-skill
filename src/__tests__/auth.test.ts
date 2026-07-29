import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAuth, ensureApiKey, getSelfUser, resolveAgentName, resolveAgentNameFromCwd } from "../auth";
import { LinearApiError, linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedLinearGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

describe("checkAuth", () => {
  const ENV_KEYS = ["LINEAR_OAUTH_TOKEN", "LINEAR_API_KEY", "LINEAR_DEVELOPER_TOKEN", "HOME"] as const;
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedLinearGraphQL.mockReset();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HOME = "/tmp/no-linear-secrets-home";
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/no-linear-secrets-cwd");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    cwdSpy.mockRestore();
  });

  it("returns the viewer on success", async () => {
    process.env.LINEAR_API_KEY = "test-token";
    mockedLinearGraphQL.mockResolvedValue({
      viewer: {
        id: "user-1",
        name: "Matt Fancy",
        email: "matt@example.com"
      }
    });

    await expect(checkAuth()).resolves.toEqual({
      id: "user-1",
      name: "Matt Fancy",
      email: "matt@example.com"
    });
  });

  it("fails loudly when LINEAR_API_KEY is missing", async () => {
    await expect(checkAuth()).rejects.toThrow("No Linear API key found for agent");
  });

  it("fails loudly when the LINEAR_API_KEY is invalid", async () => {
    process.env.LINEAR_API_KEY = "bad-token";
    mockedLinearGraphQL.mockRejectedValue(new LinearApiError("Unauthorized", "UNAUTHORIZED"));

    await expect(checkAuth()).rejects.toThrow("LINEAR_API_KEY is invalid: Unauthorized");
  });
});

describe("getSelfUser (INF-995: viewer query must select `app`)", () => {
  const ENV_KEYS = ["LINEAR_OAUTH_TOKEN", "LINEAR_API_KEY", "LINEAR_DEVELOPER_TOKEN", "HOME"] as const;
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedLinearGraphQL.mockReset();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HOME = "/tmp/no-linear-secrets-home";
    process.env.LINEAR_API_KEY = "test-token";
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/no-linear-secrets-cwd");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    cwdSpy.mockRestore();
  });

  // INF-995: getSelfUser omitting `app` from the viewer selection left self.app
  // undefined, so the delegate-to-self verbs (manage, consider-work) skipped the
  // INF-907 delegate/stateId split and Linear silently dropped the app-user
  // delegate (AI-1395) → NULL-DELEGATE stall. The query MUST request `app`.
  it("selects the `app` field in the viewer query", async () => {
    mockedLinearGraphQL.mockResolvedValue({
      viewer: { id: "user-1", name: "Igor", email: "igor@example.com", app: true },
    });

    await getSelfUser();

    expect(mockedLinearGraphQL).toHaveBeenCalledTimes(1);
    const query = mockedLinearGraphQL.mock.calls[0][0] as string;
    // Assert the field lands inside the viewer selection set, not just anywhere.
    expect(query).toMatch(/viewer\s*{[^}]*\bapp\b[^}]*}/);
  });

  it("surfaces the viewer's `app` flag to the caller", async () => {
    mockedLinearGraphQL.mockResolvedValue({
      viewer: { id: "user-1", name: "Igor", email: "igor@example.com", app: true },
    });

    await expect(getSelfUser()).resolves.toEqual({
      id: "user-1",
      name: "Igor",
      email: "igor@example.com",
      app: true,
    });
  });
});

describe("ensureApiKey precedence (AI-2427: file wins over stale env)", () => {
  // Include OPENCLAW_* name sources + OPENCLAW_CONFIG_DIR so the live container
  // env (which sets OPENCLAW_MCP_AGENT_ID/OPENCLAW_AGENT_NAME) can't leak in and
  // outrank the cwd-derived agent name this test relies on.
  const ENV_KEYS = [
    "LINEAR_OAUTH_TOKEN",
    "LINEAR_API_KEY",
    "LINEAR_DEVELOPER_TOKEN",
    "OPENCLAW_MCP_AGENT_ID",
    "OPENCLAW_AGENT_NAME",
    "OPENCLAW_CONFIG_DIR",
    "HOME",
  ] as const;
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};
  let cwdSpy: jest.SpyInstance;
  let tmpHome: string;

  const AGENT = "testagent";
  const writeSecretFile = (token: string): void => {
    const dir = path.join(tmpHome, ".openclaw", "workspace", AGENT, ".secrets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "linear.env"), `LINEAR_OAUTH_TOKEN=${token}\n`);
  };

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "linear-auth-test-"));
    process.env.HOME = tmpHome;
    // Resolve the agent name to `testagent` so the secret file path is derived.
    cwdSpy = jest
      .spyOn(process, "cwd")
      .mockReturnValue(path.join(tmpHome, ".openclaw", "workspace", AGENT));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    cwdSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns the file token even when a (stale) env token is present", () => {
    writeSecretFile("file-token-fresh");
    process.env.LINEAR_OAUTH_TOKEN = "env-token-stale";

    expect(ensureApiKey()).toBe("file-token-fresh");
    // process.env.LINEAR_API_KEY is normalized to the resolved token.
    expect(process.env.LINEAR_API_KEY).toBe("file-token-fresh");
  });

  it("falls back to the env token when no secret file exists", () => {
    // No writeSecretFile() call — file absent.
    process.env.LINEAR_OAUTH_TOKEN = "env-token-only";

    expect(ensureApiKey()).toBe("env-token-only");
  });

  it("throws when neither a file token nor an env token is available", () => {
    expect(() => ensureApiKey()).toThrow("No Linear API key found for agent");
  });
});

describe("resolveAgentName", () => {
  const ENV_KEYS = ["OPENCLAW_MCP_AGENT_ID", "OPENCLAW_AGENT_NAME", "HOME"] as const;
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};
  let warnSpy: jest.SpyInstance;
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/no-linear-secrets-cwd");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    warnSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it("uses OPENCLAW_MCP_AGENT_ID as primary", () => {
    process.env.OPENCLAW_MCP_AGENT_ID = "charles";
    process.env.HOME = "/home/somebody";
    expect(resolveAgentName().name).toBe("charles");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to OPENCLAW_AGENT_NAME when MCP id is unset", () => {
    process.env.OPENCLAW_AGENT_NAME = "astrid";
    expect(resolveAgentName().name).toBe("astrid");
  });

  it("falls back to cwd when both env vars are unset", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/igor");
    expect(resolveAgentName().name).toBe("igor");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns no name when no source is available (bare workspace cwd)", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace");
    expect(resolveAgentName().name).toBeUndefined();
  });

  it("resolves from cwd with nested subdirectory", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/felix/tmp/x");
    expect(resolveAgentName().name).toBe("felix");
  });

  it("resolves from cwd with trailing slash", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/noah/");
    expect(resolveAgentName().name).toBe("noah");
  });

  it("warns when env and cwd disagree and uses env (highest priority)", () => {
    process.env.OPENCLAW_AGENT_NAME = "charles";
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/igor");
    expect(resolveAgentName().name).toBe("charles");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("disagree");
  });

  it("does not warn when env and cwd agree", () => {
    process.env.OPENCLAW_AGENT_NAME = "igor";
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/igor");
    expect(resolveAgentName().name).toBe("igor");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns when sources disagree and uses highest priority", () => {
    process.env.OPENCLAW_MCP_AGENT_ID = "charles";
    process.env.OPENCLAW_AGENT_NAME = "astrid";
    expect(resolveAgentName().name).toBe("charles");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("disagree");
  });

  it("does not warn when sources agree (case-insensitive)", () => {
    process.env.OPENCLAW_MCP_AGENT_ID = "Hanzo";
    process.env.OPENCLAW_AGENT_NAME = "hanzo";
    expect(resolveAgentName().name).toBe("hanzo");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("includes cwd source in the returned sources array", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/sage");
    const result = resolveAgentName();
    expect(result.sources).toEqual([
      { source: "cwd", value: "sage" },
    ]);
  });

  it("orders sources correctly: env before cwd", () => {
    process.env.OPENCLAW_AGENT_NAME = "igor";
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/igor");
    const result = resolveAgentName();
    expect(result.sources[0]).toEqual({ source: "OPENCLAW_AGENT_NAME", value: "igor" });
    expect(result.sources[1]).toEqual({ source: "cwd", value: "igor" });
  });
});

describe("resolveAgentNameFromCwd", () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it("resolves agent name from standard workspace path", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/igor");
    expect(resolveAgentNameFromCwd()).toBe("igor");
  });

  it("resolves from nested subdirectory within agent workspace", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/felix/tmp/deep/nested");
    expect(resolveAgentNameFromCwd()).toBe("felix");
  });

  it("returns undefined for bare workspace directory (main agent)", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace");
    expect(resolveAgentNameFromCwd()).toBeUndefined();
  });

  it("returns undefined for workspace directory with trailing slash", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/");
    expect(resolveAgentNameFromCwd()).toBeUndefined();
  });

  it("returns undefined for unrelated cwd", () => {
    cwdSpy.mockReturnValue("/tmp/some/random/path");
    expect(resolveAgentNameFromCwd()).toBeUndefined();
  });

  it("rejects dot-prefixed segments", () => {
    cwdSpy.mockReturnValue("/home/node/.openclaw/workspace/.hidden");
    expect(resolveAgentNameFromCwd()).toBeUndefined();
  });
});
