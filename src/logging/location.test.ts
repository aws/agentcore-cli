import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileLogger } from "./fileLogger";
import { LOG_LEVEL } from "./types";
import { detailedLogLocation, logFilePrefix, rotatedLogFile } from "./location";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("rotatedLogFile", () => {
  test("names the file the rotating logger writes", async () => {
    // The point of the function: it predicts a name winston chooses, so it is
    // checked against the file a real logger leaves behind rather than against the
    // pattern it was written from.
    const directory = await mkdtemp(join(tmpdir(), "agentcore-logs-"));
    tempDirectories.push(directory);
    const prefix = join(directory, "output");

    const logger = createFileLogger({ filePath: prefix, logLevel: LOG_LEVEL.DEBUG });
    logger.info("example");
    await logger.end();

    // The transport also writes a hidden audit file beside the log.
    const written = (await readdir(directory)).filter((name) => name.endsWith(".log"));
    expect(written).toEqual([rotatedLogFile("output", new Date())]);
  });

  test("pads a single-digit month and day, as the date pattern does", () => {
    expect(rotatedLogFile("output", new Date(2026, 0, 5))).toBe("output-2026-01-05.log");
  });
});

describe("detailedLogLocation", () => {
  test("points at the file the logger writes, with the home directory shortened", () => {
    const home = join(tmpdir(), "example-home");
    const at = new Date(2026, 7, 17, 13, 45);

    expect(detailedLogLocation(at, home)).toBe(
      join("~", ".agentcore", "logs", "output-2026-08-17.log"),
    );
    // The same file spelled in full, which is what the `~` stands in for.
    expect(rotatedLogFile(logFilePrefix(home), at)).toBe(
      join(home, ".agentcore", "logs", "output-2026-08-17.log"),
    );
  });

  test("stays absolute for a log that does not sit under the home directory", () => {
    // Nothing shortens to a bare `~`, so a home of `/` is spelled out instead.
    expect(detailedLogLocation(new Date(2026, 7, 17), "/")).toBe(
      join("/", ".agentcore", "logs", "output-2026-08-17.log"),
    );
  });
});
