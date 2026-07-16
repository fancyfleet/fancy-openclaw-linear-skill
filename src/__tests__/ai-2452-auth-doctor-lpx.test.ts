/**
 * AI-2452 (defect 2): `auth doctor` printed "⚠️ Unknown token format" for the
 * fleet's *healthy* configuration.
 *
 * Every correctly-provisioned agent holds an `lpx_` proxy token issued by the
 * connector. The token-type check only knew `lin_oauth_` and `lin_api_`, so the
 * end state of the whole broker migration fell to the `else` branch and warned.
 * A check that warns loudest when everything is right is training to ignore it.
 *
 * These drive the real `linearDoctor()` and assert on what it actually prints —
 * a pure helper passing in isolation would not prove the doctor says anything.
 */
import { linearDoctor } from "../auth";
import { linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedLinearGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

const ENV_KEYS = ["LINEAR_OAUTH_TOKEN", "LINEAR_API_KEY", "LINEAR_DEVELOPER_TOKEN", "HOME"] as const;

/** Run the doctor with `token` as the only credential in the environment. */
async function doctorOutputFor(token: string): Promise<string> {
  process.env.LINEAR_API_KEY = token;
  const lines: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await linearDoctor();
  } finally {
    logSpy.mockRestore();
  }
  return lines.join("\n");
}

describe("AI-2452: auth doctor token-type detection", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedLinearGraphQL.mockReset();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Keep ensureApiKey() off any real .secrets/linear.env on this machine, so the
    // token under test is the one the doctor actually resolves. (Same pattern as
    // auth.test.ts — file-first precedence, AI-2427.)
    process.env.HOME = "/tmp/no-linear-secrets-home";
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/tmp/no-linear-secrets-cwd");

    // viewer / teams / issues all route through linearGraphQL.
    mockedLinearGraphQL.mockResolvedValue({
      viewer: { id: "u-1", name: "Igor (Back End Dev)", email: "igor@example.com" },
      teams: { nodes: [] },
      issues: { nodes: [] }
    } as any);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("recognizes an lpx_ proxy token as healthy", async () => {
    const output = await doctorOutputFor("lpx_live_proxy_token_abc123");

    expect(output).toContain("proxy token");
    expect(output).toMatch(/✅[^\n]*proxy token/);
  });

  it("does not warn about the fleet's standard proxy token", async () => {
    const output = await doctorOutputFor("lpx_live_proxy_token_abc123");

    expect(output).not.toContain("Unknown token format");
    expect(output).not.toContain("⚠️");
  });

  it("never prints the proxy token itself", async () => {
    // The old else-branch echoed the first 20 chars of the credential.
    const output = await doctorOutputFor("lpx_live_proxy_token_abc123");
    expect(output).not.toContain("lpx_live_proxy_token");
  });

  it("still recognizes an OAuth token", async () => {
    const output = await doctorOutputFor("lin_oauth_abc123");
    expect(output).toContain("OAuth token");
    expect(output).not.toContain("Unknown token format");
  });

  it("still recognizes a personal API key", async () => {
    const output = await doctorOutputFor("lin_api_abc123");
    expect(output).toContain("personal API key");
    expect(output).not.toContain("Unknown token format");
  });

  it("still warns on a genuinely unrecognized token format", async () => {
    // The warning must keep working — this fix narrows the else branch, it does
    // not delete the signal.
    const output = await doctorOutputFor("wat_something_else");
    expect(output).toContain("Unknown token format");
    expect(output).toContain("wat_");
  });

  it("does not echo an unrecognized credential, even with no prefix to strip", async () => {
    // The old branch printed the first 20 chars of the live token verbatim. A
    // value with no underscore has no prefix that is safe to show at all.
    const output = await doctorOutputFor("abc123deadbeefsecret");

    expect(output).toContain("Unknown token format");
    expect(output).not.toContain("abc123deadbeefsecret");
    expect(output).not.toContain("abc123");
  });
});
