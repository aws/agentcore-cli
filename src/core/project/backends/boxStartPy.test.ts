import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeRuntimeProfile } from "../runtimeProfile/serialize";

/** The CodeZip box agent's entry point, which runs on the Runtime's Python. */
const START_PY = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "assets",
  "templates",
  "box-codezip",
  "start.py",
);

/** A Python 3 on PATH, which the CI runners have; the tests skip without one. */
const PYTHON = ["python3", "python"].find((name) => {
  // On Windows, spawnSync throws, rather than failing, for a name not on PATH.
  try {
    return (
      Bun.spawnSync([name, "-c", "import sys; assert sys.version_info >= (3,)"]).exitCode === 0
    );
  } catch {
    return false;
  }
});

/**
 * Runs start.py's staged_policies on `profile` as Python 3.10 does, with no tomllib: only the
 * imports and the function run, not the rest of start.py, which would start box.
 */
const HARNESS = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
keep = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))
        or (isinstance(n, ast.FunctionDef) and n.name == "staged_policies")]
scope = {}
exec(compile(ast.Module(body=keep, type_ignores=[]), "start.py", "exec"), scope)
scope["tomllib"] = None
print(json.dumps(scope["staged_policies"](sys.argv[2])))
`;

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function run(profile: string) {
  const folder = await mkdtemp(join(tmpdir(), "box-start-py-"));
  folders.push(folder);
  const path = join(folder, "profile.toml");
  await writeFile(path, profile);
  const result = Bun.spawnSync([PYTHON!, "-c", HARNESS, START_PY, path]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** A Runtime profile as the runtime profile writer writes it, with a header comment. */
const runtimeProfile = (policies?: string[]) =>
  serializeRuntimeProfile(
    { packs: ["@box/base"], ...(policies && { policies }), profile: { name: "V3Demo" } },
    ["Runs the agent of the AgentCore project 'V3Demo' in a box."],
  );

describe.skipIf(PYTHON === undefined)("start.py with no tomllib, as on Python 3.10", () => {
  test("reads the policies of a Runtime profile that the runtime profile writer writes", async () => {
    const result = await run(runtimeProfile(["policy.dw", "rules/extra.dw"]));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["policy.dw", "rules/extra.dw"]);
  });

  test("reads no policies from a profile that names none", async () => {
    const result = await run(runtimeProfile());

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("stops with a clear error for a policies line it cannot read", async () => {
    const result = await run('policies = [\n  "policy.dw",\n]\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("has a `policies` line start.py cannot read");
  });
});

/**
 * Runs start.py's main with its folders in a test folder and os.execve replaced, and prints what main
 * hands box: the BOX_ variables, and the standard library and base prefix of this Python.
 */
const MAIN_HARNESS = `
import json, os, sys, sysconfig, types
start = types.ModuleType("start")
start.__file__ = sys.argv[1]
exec(compile(open(sys.argv[1]).read(), "start.py", "exec"), start.__dict__)
folder = sys.argv[2]
start.DIST = os.path.join(folder, "dist")
start.BOX = os.path.join(start.DIST, "box")
start.HOME = os.path.join(folder, "home")
start.WORKSPACE = os.path.join(folder, "workspace")
start.PROFILE_DIR = os.path.join(folder, "profile")
start.PROFILE = os.path.join(start.PROFILE_DIR, "profile.toml")
def execve(path, args, env):
    box = {name: value for name, value in env.items() if name.startswith("BOX_")}
    print(json.dumps({"box": box, "stdlib": sysconfig.get_path("stdlib"), "prefix": sys.base_prefix}))
    sys.exit(0)
os.execve = execve
start.main()
`;

describe.skipIf(PYTHON === undefined)("start.py", () => {
  test("gives box the standard library of the Runtime's Python, and not its base prefix, which box refuses as a system root (/usr on the Runtime)", async () => {
    const folder = await mkdtemp(join(tmpdir(), "box-start-py-"));
    folders.push(folder);
    await mkdir(join(folder, "dist"));
    await writeFile(join(folder, "dist", "profile.toml"), runtimeProfile());

    const result = Bun.spawnSync([PYTHON!, "-c", MAIN_HARNESS, START_PY, folder]);

    expect(result.stderr.toString()).toBe("");
    const { box, stdlib, prefix } = JSON.parse(result.stdout.toString()) as {
      box: Record<string, string>;
      stdlib: string;
      prefix: string;
    };
    expect(box.BOX_PYTHON_STDLIB).toBe(stdlib);
    expect(Object.values(box)).not.toContain(prefix);
  });
});
