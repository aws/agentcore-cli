import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLogger } from "./fileLogger";
import { LOG_LEVEL } from "./types";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("currentFile names the file the entries were written to", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "file-logger-test-"));
  const logger = createFileLogger({ filePath: join(tempDir, "output"), logLevel: LOG_LEVEL.DEBUG });

  logger.child({ error: { name: "ResourceNotFoundException" } }).error();
  await logger.end();

  const file = logger.currentFile();
  expect(file?.startsWith(join(tempDir, "output-"))).toBe(true);
  expect(await readFile(file!, "utf-8")).toContain("ResourceNotFoundException");
});
