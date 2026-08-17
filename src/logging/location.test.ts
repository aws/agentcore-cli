import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileLogger } from "./fileLogger";
import { LOG_LEVEL } from "./types";
import { detailedLogLocation, logFilePath } from "./location";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function inTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

// A directory the CLI reads as a project: the marker it walks up to. The log is written
// outside it regardless, which is what the test below is for.
async function project(): Promise<string> {
  const root = await inTempDirectory("agentcore-project-");
  await mkdir(join(root, "agentcore"), { recursive: true });
  await writeFile(join(root, "agentcore", "agentcore.json"), "{}");
  return root;
}

const AT = new Date(2026, 7, 17, 13, 45, 6);
const RUN_LOG = "agentcore-20260817-134506.log";
const HOME = join(tmpdir(), "example-home");

describe("logFilePath", () => {
  test("names one file per run, under the CLI's own state", () => {
    expect(logFilePath({ home: HOME, at: AT })).toBe(join(HOME, ".agentcore", "logs", RUN_LOG));
  });

  test("pads every single-digit part of the timestamp", () => {
    expect(logFilePath({ home: HOME, at: new Date(2026, 0, 5, 9, 8, 7) })).toBe(
      join(HOME, ".agentcore", "logs", "agentcore-20260105-090807.log"),
    );
  });

  test("names the same file however long the run takes", () => {
    // The run's log is decided once: a command that prints where its log is has to name
    // the file the logger opened, not one named for the moment it printed.
    expect(logFilePath({ home: HOME })).toBe(logFilePath({ home: HOME }));
  });

  test("is the same file wherever the command ran and whatever was typed", async () => {
    const expected = join(HOME, ".agentcore", "logs", RUN_LOG);
    const cwd = process.cwd();
    const argv = process.argv;

    // Neither input a user controls reaches the path. Being inside a project does not move
    // the log into it, and nothing is read from argv: a token taken for a command name is
    // as likely to be a positional argument, and `config endpoint ../../../tmp/pwn` once
    // put the log wherever that resolved to.
    try {
      process.chdir(await project());
      process.argv = ["node", "agentcore", "config", "endpoint", "../../../../../../tmp/pwn"];
      expect(logFilePath({ home: HOME, at: AT })).toBe(expected);
      process.argv = ["node", "agentcore", "config", "telemetry.enabled", "false"];
      expect(logFilePath({ home: HOME, at: AT })).toBe(expected);
    } finally {
      process.chdir(cwd);
      process.argv = argv;
    }
  });

  test("is the file a real logger writes, and one file per run", async () => {
    // The point of the function: it names the file winston is handed, so it is checked
    // against what a real logger leaves behind — including the logs directory, which no
    // run has created yet.
    const home = await inTempDirectory("agentcore-home-");
    const first = logFilePath({ home, at: AT });
    const second = logFilePath({ home, at: new Date(2026, 7, 17, 13, 45, 7) });

    for (const [filePath, message] of [
      [first, "first run"],
      [second, "second run"],
    ] as const) {
      const logger = createFileLogger({ filePath, logLevel: LOG_LEVEL.DEBUG });
      logger.info(message);
      await logger.end();
    }

    expect((await readdir(join(home, ".agentcore", "logs"))).sort()).toEqual([
      "agentcore-20260817-134506.log",
      "agentcore-20260817-134507.log",
    ]);
    // A later run writes its own file rather than appending to the run before it.
    expect(await readFile(first, "utf8")).toContain("first run");
    expect(await readFile(first, "utf8")).not.toContain("second run");
  });
});

describe("detailedLogLocation", () => {
  test("shortens the home directory it sits under to `~`", () => {
    expect(detailedLogLocation({ home: HOME, at: AT })).toBe(
      join("~", ".agentcore", "logs", RUN_LOG),
    );
    // Spells the file the logger actually writes, just more briefly.
    expect(logFilePath({ home: HOME, at: AT })).toBe(join(HOME, ".agentcore", "logs", RUN_LOG));
  });

  test("stays absolute for a log that does not sit under the home directory", () => {
    // Nothing shortens to a bare `~`, so a home of `/` is spelled out instead.
    expect(detailedLogLocation({ home: "/", at: AT })).toBe(
      join("/", ".agentcore", "logs", RUN_LOG),
    );
  });
});
