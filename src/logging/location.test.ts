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

// A directory the location functions read as a project: the marker they walk up to.
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  await writeFile(join(root, "agentcore", "agentcore.json"), "{}");
  return root;
}

async function outsideAnyProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-elsewhere-"));
  tempDirectories.push(directory);
  return directory;
}

const AT = new Date(2026, 7, 17, 13, 45, 6);
const RUN_LOG = "agentcore-20260817-134506.log";

describe("logFilePath", () => {
  test("names one file per run, in the project the command was run in", async () => {
    const root = await project();

    expect(logFilePath({ cwd: root, at: AT })).toBe(
      join(root, "agentcore", ".cli", "logs", RUN_LOG),
    );
  });

  test("pads every single-digit part of the timestamp", async () => {
    const root = await project();

    expect(logFilePath({ cwd: root, at: new Date(2026, 0, 5, 9, 8, 7) })).toBe(
      join(root, "agentcore", ".cli", "logs", "agentcore-20260105-090807.log"),
    );
  });

  test("names the same file however long the run takes", async () => {
    const root = await project();

    // The run's log is decided once: a command that prints where its log is has to name
    // the file the logger opened, not one named for the moment it printed.
    expect(logFilePath({ cwd: root })).toBe(logFilePath({ cwd: root }));
  });

  test("finds the project from a directory inside it", async () => {
    const root = await project();
    const inside = join(root, "app", "src");
    await mkdir(inside, { recursive: true });

    expect(logFilePath({ cwd: inside, at: AT })).toBe(
      join(root, "agentcore", ".cli", "logs", RUN_LOG),
    );
  });

  test("falls back to the home directory outside a project", async () => {
    const home = join(tmpdir(), "example-home");

    expect(logFilePath({ cwd: await outsideAnyProject(), home, at: AT })).toBe(
      join(home, ".agentcore", "logs", RUN_LOG),
    );
  });

  test("is decided by where the command ran, not by what was typed", async () => {
    const root = await project();
    const expected = join(root, "agentcore", ".cli", "logs", RUN_LOG);
    const argv = process.argv;

    // Naming the log after the command means parsing argv, and a token taken for a
    // command is as likely to be a positional argument: `config endpoint ../../../tmp`
    // once put the log wherever that resolved to. Nothing here reads argv at all.
    try {
      process.argv = ["node", "agentcore", "config", "endpoint", "../../../../../../tmp/pwn"];
      expect(logFilePath({ cwd: root, at: AT })).toBe(expected);
      process.argv = ["node", "agentcore", "config", "telemetry.enabled", "false"];
      expect(logFilePath({ cwd: root, at: AT })).toBe(expected);
    } finally {
      process.argv = argv;
    }
  });

  test("is the file a real logger writes, and one file per run", async () => {
    // The point of the function: it names the file winston is handed, so it is checked
    // against what a real logger leaves behind — including the logs directory, which no
    // run has created yet.
    const root = await project();
    const first = logFilePath({ cwd: root, at: AT });
    const second = logFilePath({ cwd: root, at: new Date(2026, 7, 17, 13, 45, 7) });

    for (const [filePath, message] of [
      [first, "first run"],
      [second, "second run"],
    ] as const) {
      const logger = createFileLogger({ filePath, logLevel: LOG_LEVEL.DEBUG });
      logger.info(message);
      await logger.end();
    }

    expect((await readdir(join(root, "agentcore", ".cli", "logs"))).sort()).toEqual([
      "agentcore-20260817-134506.log",
      "agentcore-20260817-134507.log",
    ]);
    // A later run writes its own file rather than appending to the run before it.
    expect(await readFile(first, "utf8")).toContain("first run");
    expect(await readFile(first, "utf8")).not.toContain("second run");
  });
});

describe("detailedLogLocation", () => {
  test("names a project's log relative to where the command ran", async () => {
    const root = await project();

    expect(detailedLogLocation({ at: AT, cwd: root })).toBe(
      join("agentcore", ".cli", "logs", RUN_LOG),
    );
    // Run from a subdirectory, the same file is named relative to that.
    const inside = join(root, "agentcore");
    expect(detailedLogLocation({ at: AT, cwd: inside })).toBe(join(".cli", "logs", RUN_LOG));
    // Both spell the file the logger actually writes.
    expect(logFilePath({ cwd: inside, at: AT })).toBe(
      join(root, "agentcore", ".cli", "logs", RUN_LOG),
    );
  });

  test("shortens the fallback log to `~` rather than making it relative", async () => {
    const elsewhere = await outsideAnyProject();
    const home = join(tmpdir(), "example-home");

    expect(detailedLogLocation({ at: AT, cwd: elsewhere, home })).toBe(
      join("~", ".agentcore", "logs", RUN_LOG),
    );
    expect(logFilePath({ cwd: elsewhere, home, at: AT })).toBe(
      join(home, ".agentcore", "logs", RUN_LOG),
    );
  });

  test("stays absolute for a log that does not sit under the home directory", async () => {
    // Nothing shortens to a bare `~`, so a home of `/` is spelled out instead.
    expect(detailedLogLocation({ at: AT, cwd: await outsideAnyProject(), home: "/" })).toBe(
      join("/", ".agentcore", "logs", RUN_LOG),
    );
  });
});
