import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneOldLogs, RETENTION } from "./retention";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function logDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-logs-"));
  tempDirectories.push(directory);
  return directory;
}

// A log of `bytes` bytes, so a test can put the directory over the byte ceiling.
async function log(directory: string, name: string, bytes = 1): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, "x".repeat(bytes));
  return path;
}

function runLog(second: number): string {
  return `agentcore-20260817-1345${String(second).padStart(2, "0")}.log`;
}

async function remaining(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

const NO_BYTE_LIMIT = { runs: RETENTION.runs, bytes: Number.MAX_SAFE_INTEGER };

describe("pruneOldLogs", () => {
  test("keeps the newest runs and deletes the runs before them", async () => {
    const directory = await logDirectory();
    for (let second = 1; second <= 6; second += 1) await log(directory, runLog(second));
    const current = join(directory, runLog(6));

    expect(await pruneOldLogs(current, { runs: 3, bytes: Number.MAX_SAFE_INTEGER })).toBe(3);

    // The three newest, which for the run doing the pruning includes its own.
    expect(await remaining(directory)).toEqual([runLog(4), runLog(5), runLog(6)]);
  });

  test("never deletes the log this run is writing", async () => {
    const directory = await logDirectory();
    // The oldest file is this run's, which happens when the clock moved backwards: even
    // then a run cannot delete the file it still has open.
    const current = await log(directory, runLog(1));
    for (const second of [2, 3, 4]) await log(directory, runLog(second));

    await pruneOldLogs(current, { runs: 1, bytes: Number.MAX_SAFE_INTEGER });

    expect(await remaining(directory)).toEqual([runLog(1), runLog(4)]);
  });

  test("deletes the oldest runs until what is left fits the byte ceiling", async () => {
    const directory = await logDirectory();
    // A deploy's log is the large one, and a few of them reach the ceiling long before
    // the run count does.
    for (const second of [1, 2, 3]) await log(directory, runLog(second), 400);
    const current = await log(directory, runLog(4), 400);

    expect(await pruneOldLogs(current, { runs: 50, bytes: 1000 })).toBe(2);

    expect(await remaining(directory)).toEqual([runLog(3), runLog(4)]);
  });

  test("keeps this run's log even when it alone exceeds the ceiling", async () => {
    const directory = await logDirectory();
    await log(directory, runLog(1), 10);
    const current = await log(directory, runLog(2), 5000);

    await pruneOldLogs(current, { runs: 50, bytes: 1000 });

    expect(await remaining(directory)).toEqual([runLog(2)]);
  });

  test("deletes the daily logs an earlier version left behind", async () => {
    const directory = await logDirectory();
    // What the rotating file wrote before one file per run replaced it. Nothing else would
    // ever delete these, so an upgrade does not leave a directory that only grows.
    await log(directory, "output-2026-08-10.log");
    await log(directory, "output-2026-08-17.log");
    const current = await log(directory, runLog(1));

    expect(await pruneOldLogs(current, { runs: 2, bytes: Number.MAX_SAFE_INTEGER })).toBe(1);

    // The older daily file goes first: a date sorts before any run of that date.
    expect(await remaining(directory)).toEqual([runLog(1), "output-2026-08-17.log"]);
  });

  test("leaves files it did not write", async () => {
    const directory = await logDirectory();
    const current = await log(directory, runLog(2));
    await log(directory, runLog(1));
    await log(directory, "notes.txt");
    await log(directory, "deploy-20260817-134506.log");

    expect(await pruneOldLogs(current, { runs: 1, bytes: Number.MAX_SAFE_INTEGER })).toBe(1);

    // Only the CLI's own logs are pruned, so a file a user copied in stays where they put it.
    expect(await remaining(directory)).toEqual([
      runLog(2),
      "deploy-20260817-134506.log",
      "notes.txt",
    ]);
  });

  test("prunes nothing when this run has yet to write anything", async () => {
    // The first run on a machine: the directory the transport is about to create.
    const directory = join(await logDirectory(), "not-created-yet");

    expect(await pruneOldLogs(join(directory, runLog(1)), NO_BYTE_LIMIT)).toBe(0);
  });

  test("bounds the directory by default rather than letting it grow", async () => {
    // The ceiling the rotating file enforced before one file per run replaced it, so the
    // default is a bound and not merely a large number.
    expect(RETENTION.bytes).toBe(50 * 1024 * 1024);
    expect(RETENTION.runs).toBeGreaterThan(0);
  });
});
