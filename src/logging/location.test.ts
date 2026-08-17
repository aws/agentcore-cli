import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

// A directory the location functions read as a project: the marker they walk up to.
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  await writeFile(join(root, "agentcore", "agentcore.json"), "{}");
  return root;
}

// argv as the CLI is handed it: the executable and the script, then the user's tokens.
function argv(...tokens: string[]): string[] {
  return ["node", "agentcore", ...tokens];
}

describe("rotatedLogFile", () => {
  test("names the file the rotating logger writes", async () => {
    // The point of the function: it predicts a name winston chooses, so it is
    // checked against the file a real logger leaves behind rather than against the
    // pattern it was written from.
    const directory = await mkdtemp(join(tmpdir(), "agentcore-logs-"));
    tempDirectories.push(directory);
    // Nested under a command as the real prefix is, which also covers the transport
    // creating that directory rather than failing on a path that does not exist yet.
    const commandDirectory = join(directory, "deploy");

    const logger = createFileLogger({
      filePath: join(commandDirectory, "deploy"),
      logLevel: LOG_LEVEL.DEBUG,
    });
    logger.info("example");
    await logger.end();

    // The transport also writes a hidden audit file beside the log.
    const written = (await readdir(commandDirectory)).filter((name) => name.endsWith(".log"));
    expect(written).toEqual([rotatedLogFile("deploy", new Date())]);
  });

  test("pads a single-digit month and day, as the date pattern does", () => {
    expect(rotatedLogFile("deploy", new Date(2026, 0, 5))).toBe("deploy-2026-01-05.log");
  });
});

describe("logFilePrefix", () => {
  test("writes into the project the command was run from, filed under the command", async () => {
    const root = await project();

    expect(logFilePrefix({ cwd: root, argv: argv("project", "deploy") })).toBe(
      join(root, "agentcore", ".cli", "logs", "deploy", "deploy"),
    );
  });

  test("finds the project from a directory inside it", async () => {
    const root = await project();
    const inside = join(root, "app", "src");
    await mkdir(inside, { recursive: true });

    expect(logFilePrefix({ cwd: inside, argv: argv("project", "deploy") })).toBe(
      join(root, "agentcore", ".cli", "logs", "deploy", "deploy"),
    );
  });

  test("falls back to the home directory outside a project", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "agentcore-elsewhere-"));
    tempDirectories.push(elsewhere);
    const home = join(tmpdir(), "example-home");

    expect(logFilePrefix({ cwd: elsewhere, home, argv: argv("project", "deploy") })).toBe(
      join(home, ".agentcore", "logs", "deploy", "deploy"),
    );
  });

  test("names the command whatever surrounds it on the command line", async () => {
    const root = await project();
    const deploy = join(root, "agentcore", ".cli", "logs", "deploy", "deploy");

    // A global flag's value is not a command, and neither is a flag after one.
    expect(logFilePrefix({ cwd: root, argv: argv("project", "deploy", "--target", "prod") })).toBe(
      deploy,
    );
    expect(
      logFilePrefix({ cwd: root, argv: argv("--region", "us-east-1", "project", "deploy") }),
    ).toBe(deploy);
    expect(logFilePrefix({ cwd: root, argv: argv("--verbose", "project", "deploy") })).toBe(deploy);
  });

  test("files a run with no command of its own under the CLI itself", async () => {
    const root = await project();
    const bare = join(root, "agentcore", ".cli", "logs", "agentcore", "agentcore");

    // The TUI, and the TUI with a global flag that could be mistaken for a command.
    expect(logFilePrefix({ cwd: root, argv: argv() })).toBe(bare);
    expect(logFilePrefix({ cwd: root, argv: argv("--region", "us-east-1") })).toBe(bare);
  });
});

describe("detailedLogLocation", () => {
  const DEPLOY = argv("project", "deploy");

  test("names a project's log relative to where the command ran", async () => {
    const root = await project();
    const at = new Date(2026, 7, 17, 13, 45);

    expect(detailedLogLocation({ at, cwd: root, argv: DEPLOY })).toBe(
      join("agentcore", ".cli", "logs", "deploy", "deploy-2026-08-17.log"),
    );
    // Run from a subdirectory, the same file is named relative to that.
    const inside = join(root, "agentcore");
    expect(detailedLogLocation({ at, cwd: inside, argv: DEPLOY })).toBe(
      join(".cli", "logs", "deploy", "deploy-2026-08-17.log"),
    );
    // Both spell the file the logger actually writes.
    expect(rotatedLogFile(logFilePrefix({ cwd: inside, argv: DEPLOY }), at)).toBe(
      join(root, "agentcore", ".cli", "logs", "deploy", "deploy-2026-08-17.log"),
    );
  });

  test("shortens the fallback log to `~` rather than making it relative", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "agentcore-elsewhere-"));
    tempDirectories.push(elsewhere);
    const home = join(tmpdir(), "example-home");
    const at = new Date(2026, 7, 17, 13, 45);

    expect(detailedLogLocation({ at, cwd: elsewhere, home, argv: DEPLOY })).toBe(
      join("~", ".agentcore", "logs", "deploy", "deploy-2026-08-17.log"),
    );
    expect(rotatedLogFile(logFilePrefix({ cwd: elsewhere, home, argv: DEPLOY }), at)).toBe(
      join(home, ".agentcore", "logs", "deploy", "deploy-2026-08-17.log"),
    );
  });

  test("stays absolute for a log that does not sit under the home directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "agentcore-elsewhere-"));
    tempDirectories.push(elsewhere);

    // Nothing shortens to a bare `~`, so a home of `/` is spelled out instead.
    expect(
      detailedLogLocation({ at: new Date(2026, 7, 17), cwd: elsewhere, home: "/", argv: DEPLOY }),
    ).toBe(join("/", ".agentcore", "logs", "deploy", "deploy-2026-08-17.log"));
  });
});
