import { type Logger } from "../logging";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "./timing";

function parseJSONLines(content: string) {
  return content
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Find and read the first `.log` file in a directory.
 * Returns the file content, or an empty string if no log file exists yet.
 */
export async function readLogFile(dir: string): Promise<string> {
  const files = await readdir(dir).catch(() => []);
  const logFile = files.find((f) => f.endsWith(".log"));
  if (!logFile) return "";
  return readFile(join(dir, logFile), "utf-8");
}

const noop = () => {};

/**
 * Create a silent logger that discards all output.
 */
export function createSilentLogger(): Logger {
  const silent: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silent,
  };
  return silent;
}

/** A predicate over parsed log lines with an optional exact match count. */
export interface LogQuery {
  filter: (log: object) => boolean;
  expectedCount?: number;
}

/**
 * Asserts that log lines in {@link dir} satisfy all provided queries.
 *
 * @param dir - Directory containing `.log` files (as created by `createFileLogger`).
 * @param queries - One or more queries to assert against the log lines.
 * @param options.timeoutMs - Max time to wait in ms (default: 2000).
 */
export async function assertLogsMatch(
  dir: string,
  queries: LogQuery[],
  options?: { timeoutMs?: number },
): Promise<void> {
  let lastResults: ReturnType<typeof evaluateQueries> = [];

  // Poll until all query conditions are satisfied.
  try {
    await waitFor(async () => {
      const content = await readLogFile(dir);
      if (!content.trim()) return false;
      const lines = parseJSONLines(content);
      lastResults = evaluateQueries(lines, queries);
      return lastResults.every((r) => r.passed);
    }, options?.timeoutMs ?? 2000);
  } catch {
    const failures = lastResults
      .filter((r) => !r.passed)
      .map((r) => {
        const expected =
          r.query.expectedCount != null ? `exactly ${r.query.expectedCount}` : "at least 1";
        return `  query ${r.index}: expected ${expected}, found ${r.actual}`;
      });

    throw new Error(`assertLogsMatch timed out. Failed queries:\n${failures.join("\n")}`);
  }
}

function evaluateQueries(lines: object[], queries: LogQuery[]) {
  return queries.map((query, index) => {
    const actual = lines.filter(query.filter).length;
    const passed = query.expectedCount != null ? actual === query.expectedCount : actual > 0;
    return { query, index, actual, passed };
  });
}
