import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../testing";
import { watchFile } from "./watchFile";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempFile(): string {
  dir = mkdtempSync(join(tmpdir(), "watch-"));
  const path = join(dir, "agentcore.json");
  writeFileSync(path, "{}");
  return path;
}

test("debounces a burst of edits into a single callback and stops on abort", async () => {
  const path = tempFile();
  const controller = new AbortController();
  let calls = 0;
  watchFile(path, () => calls++, controller.signal);
  // Bun registers the macOS kqueue watch off-thread, so edits written before it is live are dropped.
  await Bun.sleep(100);

  writeFileSync(path, '{"a":1}');
  writeFileSync(path, '{"a":2}');
  await waitFor(() => calls > 0);
  expect(calls).toBe(1);

  controller.abort();
  writeFileSync(path, '{"a":3}');
  await Bun.sleep(250);
  expect(calls).toBe(1);
});

test("a missing file fails quietly rather than throwing", () => {
  expect(() =>
    watchFile(
      join(tmpdir(), "does-not-exist-agentcore.json"),
      () => {},
      new AbortController().signal,
    ),
  ).not.toThrow();
});
