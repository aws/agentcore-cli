import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The start.py that create writes as a CodeZip box runtime's entry point. */
const START_PY = join(import.meta.dir, "..", "..", "..", "assets", "templates", "box-codezip");

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A bin folder with an executable for each name, and a symbolic link for each `[link, target]`. */
function binFolder(files: string[], links: [string, string][] = []): string {
  const root = mkdtempSync(join(tmpdir(), "box-start-py-"));
  directories.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of files) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }
  for (const [link, target] of links) symlinkSync(target, join(bin, link));
  return bin;
}

/** What start.py exports as BOX_PYTHON for the Runtime Python `executable`, of version 3.12. */
function boxPython(executable: string): string {
  // Imported, not run: start.py hands over to box only as __main__.
  const out = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import start; " +
        "print(start.box_python(sys.argv[2], (3, 12)))",
      START_PY,
      executable,
    ],
    { encoding: "utf8" },
  );
  expect(out.stderr).toBe("");
  return out.stdout.trim();
}

describe("start.py BOX_PYTHON", () => {
  test("exports the Python of box_python to box, not sys.executable", () => {
    const text = readFileSync(join(START_PY, "start.py"), "utf8");

    expect(text).toContain('"BOX_PYTHON": box_python(sys.executable, sys.version_info),');
  });

  test.skipIf(!hasPython)("keeps a Python whose name box does not alias", () => {
    const bin = binFolder(["python3.12"]);

    expect(boxPython(join(bin, "python3.12"))).toBe(join(bin, "python3.12"));
  });

  test.skipIf(!hasPython)("names python3 by the versioned file beside it", () => {
    const bin = binFolder(["python3", "python3.12"]);

    expect(boxPython(join(bin, "python3"))).toBe(join(bin, "python3.12"));
  });

  test.skipIf(!hasPython)(
    "names python by the file it links to when no versioned file is beside it",
    () => {
      const bin = binFolder(["python3.12-real"], [["python", "python3.12-real"]]);

      // The link resolves to its real path, as /var is /private/var on macOS.
      expect(boxPython(join(bin, "python"))).toBe(realpathSync(join(bin, "python3.12-real")));
    },
  );

  test.skipIf(!hasPython)("keeps an aliased name when nothing else names that Python", () => {
    const bin = binFolder(["python3"]);

    expect(boxPython(join(bin, "python3"))).toBe(join(bin, "python3"));
  });
});
