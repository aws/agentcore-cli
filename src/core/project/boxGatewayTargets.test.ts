import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_RECORD_FILES } from "./boxGatewayTargets";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentcore-record-"));
  directories.push(directory);
  return directory;
}

describe("FS_RECORD_FILES", () => {
  test("replaces the record with the new text and leaves no other file", () => {
    const directory = folder();
    const path = join(directory, "box-gateway-targets.json");
    writeFileSync(path, '{"old":[]}\n');

    FS_RECORD_FILES.write(path, '{"new":[]}\n');

    expect(readFileSync(path, "utf8")).toBe('{"new":[]}\n');
    expect(readdirSync(directory)).toEqual(["box-gateway-targets.json"]);
  });

  test("removes the partial file and throws when the record cannot take its name", () => {
    const directory = folder();
    const path = join(directory, "box-gateway-targets.json");
    // A folder in the record's place, with a file in it, refuses the rename.
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "x");

    expect(() => FS_RECORD_FILES.write(path, '{"new":[]}\n')).toThrow();

    expect(readdirSync(directory)).toEqual(["box-gateway-targets.json"]);
  });
});
