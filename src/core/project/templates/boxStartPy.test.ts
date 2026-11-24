import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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

/** The tests make symbolic links and `#!/bin/sh` files, which Windows does not run. */
const skipped = !hasPython || process.platform === "win32";

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
      // No __pycache__ in src/assets, which build copies into the package.
      "-B",
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

/**
 * What start.py's main() does in `root`, with its folders there and os.execve replaced: the box it
 * runs, its arguments, the BOX_PYTHON it exports and what box_python gives, and the files it copies
 * into the profile folder. `withTomllib` false runs it as Python 3.10 does, with no tomllib.
 */
function startRun(root: string, withTomllib: boolean) {
  const script = [
    "import json, os, sys",
    "sys.path.insert(0, sys.argv[1]); import start",
    "root = sys.argv[2]",
    "start.DIST = os.path.join(root, 'dist'); start.BOX = os.path.join(start.DIST, 'box')",
    "start.HOME = os.path.join(root, 'home'); start.WORKSPACE = os.path.join(root, 'ws')",
    "start.PROFILE_DIR = os.path.join(root, 'profile')",
    "start.PROFILE = os.path.join(start.PROFILE_DIR, 'profile.toml')",
    ...(withTomllib ? [] : ["start.tomllib = None"]),
    "def execve(path, argv, env):",
    "    copied = sorted(os.path.relpath(os.path.join(d, f), start.PROFILE_DIR)",
    "                    for d, _, fs in os.walk(start.PROFILE_DIR) for f in fs)",
    "    print(json.dumps({'path': path, 'argv': argv, 'python': env['BOX_PYTHON'],",
    "                      'expected': start.box_python(sys.executable, sys.version_info),",
    "                      'copied': copied}))",
    "    sys.exit(0)",
    "start.os.execve = execve",
    "start.main()",
  ].join("\n");
  const out = spawnSync("python3", ["-I", "-B", "-c", script, START_PY, root], {
    encoding: "utf8",
  });
  expect(out.stderr).toBe("");
  return JSON.parse(out.stdout) as {
    path: string;
    argv: string[];
    python: string;
    expected: string;
    copied: string[];
  };
}

describe("start.py main", () => {
  test.skipIf(skipped).each([
    ["with tomllib", true],
    ["as Python 3.10 does, with no tomllib", false],
  ])(
    "copies the profile and each policy file, and exports the Python of box_python (%s)",
    (_label, withTomllib) => {
      const root = mkdtempSync(join(tmpdir(), "box-start-main-"));
      directories.push(root);
      mkdirSync(join(root, "dist", "rules"), { recursive: true });
      // As the runtime profile writer writes it: policies on one line.
      writeFileSync(
        join(root, "dist", "profile.toml"),
        'packs = [ "@box/base" ]\npolicies = [ "policy.dw", "rules/extra.dw" ]\n\n[profile]\nname = "demo"\n',
      );
      writeFileSync(join(root, "dist", "policy.dw"), "// rules\n");
      writeFileSync(join(root, "dist", "rules", "extra.dw"), "// extra\n");

      const run = startRun(root, withTomllib);

      expect(run.path).toBe(join(root, "dist", "box"));
      expect(run.argv).toEqual([
        "box",
        "run",
        join(root, "profile", "profile.toml"),
        "--no-banner",
      ]);
      expect(run.python).toBe(run.expected);
      expect(run.copied).toEqual(["policy.dw", "profile.toml", join("rules", "extra.dw")]);
    },
  );
});

describe("start.py BOX_PYTHON", () => {
  test.skipIf(skipped)("keeps a Python whose name box does not alias", () => {
    const bin = binFolder(["python3.12"]);

    expect(boxPython(join(bin, "python3.12"))).toBe(join(bin, "python3.12"));
  });

  test.skipIf(skipped)("names python3 by the versioned file beside it", () => {
    const bin = binFolder(["python3", "python3.12"]);

    expect(boxPython(join(bin, "python3"))).toBe(join(bin, "python3.12"));
  });

  test.skipIf(skipped)(
    "names python by the file it links to when no versioned file is beside it",
    () => {
      const bin = binFolder(["python3.12-real"], [["python", "python3.12-real"]]);

      // The link resolves to its real path, as /var is /private/var on macOS.
      expect(boxPython(join(bin, "python"))).toBe(realpathSync(join(bin, "python3.12-real")));
    },
  );

  test.skipIf(skipped)("keeps an aliased name when nothing else names that Python", () => {
    const bin = binFolder(["python3"]);

    expect(boxPython(join(bin, "python3"))).toBe(join(bin, "python3"));
  });
});
