import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
