import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { distTag, fetchLatestVersion, handleUpdate } from "./index";
import { NetworkingError } from "../../errors";
import type { ProcessRunner } from "../../io";
import { PACKAGE_VERSION } from "../../constants";

// No golden/fixture tests here: the repo's *.fixture.test.tsx harness records and
// replays AWS SDK responses through CoreClient, but `update` makes no AWS calls —
// it queries the npm registry (fetch) and shells out to `npm install -g`
// (runProcess). There is nothing for that harness to record, so a fetch spy plus
// an injected fake runner is the right, hermetic way to cover this command.

test.each([
  ["0.28.1", "latest"],
  ["1.0.0-rc.1", "rc"],
  ["1.0.0-preview.29", "preview"],
])("distTag(%s) tracks the %s dist-tag", (version, tag) => {
  expect(distTag(version)).toBe(tag);
});

describe("fetchLatestVersion", () => {
  afterEach(() => {
    spyOn(globalThis, "fetch").mockRestore();
  });

  test("returns the version from the npm registry", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
    );
    expect(await fetchLatestVersion()).toBe("9.9.9");
    expect(fetchSpy).toHaveBeenCalledWith("https://registry.npmjs.org/@aws/agentcore/latest");
  });

  test("throws a NetworkingError when the registry responds non-OK", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 404, statusText: "Not Found" }),
    );
    await expect(fetchLatestVersion()).rejects.toBeInstanceOf(NetworkingError);
  });

  test("wraps a fetch failure (offline) as a NetworkingError", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchLatestVersion()).rejects.toBeInstanceOf(NetworkingError);
  });
});

describe("handleUpdate", () => {
  afterEach(() => {
    spyOn(globalThis, "fetch").mockRestore();
  });

  const mockLatest = (version: string) =>
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version }), { status: 200 }),
    );
  const okRunner: ProcessRunner = mock(async () => {});
  const failRunner: ProcessRunner = mock(async () => {
    throw new Error("npm exploded");
  });

  test("up-to-date when versions match, without invoking the runner", async () => {
    mockLatest(PACKAGE_VERSION);
    const runner: ProcessRunner = mock(async () => {});
    expect(await handleUpdate(false, { runner })).toEqual({
      status: "up-to-date",
      currentVersion: PACKAGE_VERSION,
      latestVersion: PACKAGE_VERSION,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test("newer-local when local is ahead of the registry", async () => {
    mockLatest("0.9.0");
    expect((await handleUpdate(false)).status).toBe("newer-local");
  });

  test("update-available when newer exists and checkOnly is set (no install)", async () => {
    mockLatest("2.0.0");
    const runner: ProcessRunner = mock(async () => {});
    expect(await handleUpdate(true, { runner })).toEqual({
      status: "update-available",
      currentVersion: PACKAGE_VERSION,
      latestVersion: "2.0.0",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test("updated when the install runner succeeds", async () => {
    mockLatest("2.0.0");
    const result = await handleUpdate(false, { runner: okRunner });
    expect(result.status).toBe("updated");
    expect(okRunner).toHaveBeenCalledWith(
      ["npm", "install", "-g", "@aws/agentcore@latest"],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
  });

  test("propagates the install failure instead of swallowing it", async () => {
    mockLatest("2.0.0");
    await expect(handleUpdate(false, { runner: failRunner })).rejects.toThrow("npm exploded");
  });
});
