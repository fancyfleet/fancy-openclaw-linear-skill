import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import axios from "axios";

import { fetchImage } from "../fetch-image";

jest.mock("axios");
jest.mock("../auth", () => ({
  ensureApiKey: jest.fn(() => "lin_api_test"),
}));

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
// fetchImage uses axios.isAxiosError; keep the real implementation.
(axios.isAxiosError as unknown) = jest.requireActual("axios").isAxiosError;

describe("fetchImage", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("rejects non-Linear hosts before making a request", async () => {
    await expect(fetchImage("https://evil.com/steal")).rejects.toThrow(/non-Linear host/);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects non-https URLs", async () => {
    await expect(fetchImage("http://uploads.linear.app/x.png")).rejects.toThrow(/non-https/);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("downloads from uploads.linear.app with the Authorization header and saves the bytes", async () => {
    const body = Buffer.from("fake-jpeg-bytes");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/jpeg" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    const result = await fetchImage("https://uploads.linear.app/abc/def");

    expect(mockedGet).toHaveBeenCalledWith(
      "https://uploads.linear.app/abc/def",
      expect.objectContaining({
        headers: { Authorization: "lin_api_test" },
        responseType: "arraybuffer",
      })
    );
    expect(result.contentType).toBe("image/jpeg");
    expect(result.bytes).toBe(body.byteLength);
    expect(result.savedPath).toBe(path.join(os.tmpdir(), "def.jpg"));
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("honors an explicit output path", async () => {
    const body = Buffer.from("png");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/png" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    const result = await fetchImage("https://uploads.linear.app/x.png", "/tmp/out.png");

    expect(result.savedPath).toBe("/tmp/out.png");
    writeSpy.mockRestore();
  });
});
