import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSpec } from "../../../projectSchemas/project";
import { renderRuntimeBoxProfile } from "../templates/boxProfile";

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

const SPEC = {
  name: "V3Demo",
  runtimes: [
    {
      name: "agent",
      build: "CodeZip",
      entrypoint: "start.py",
      codeLocation: "app/agent",
      protocol: "HTTP",
      modelProvider: "Bedrock",
    },
  ],
  agentCoreGateways: [],
} as unknown as ProjectSpec;

describe.skipIf(PYTHON === undefined)("start.py with no tomllib, as on Python 3.10", () => {
  test("reads the policies of a Runtime profile deploy renders", async () => {
    const profile = renderRuntimeBoxProfile(SPEC, SPEC.runtimes[0]!, {
      policyFiles: ["policy.dw", "rules/extra.dw"],
    });

    const result = await run(profile);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["policy.dw", "rules/extra.dw"]);
  });

  test("reads no policies from a profile that names none", async () => {
    const result = await run(renderRuntimeBoxProfile(SPEC, SPEC.runtimes[0]!));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("stops with a clear error for a policies line it cannot read", async () => {
    const result = await run('policies = [\n  "policy.dw",\n]\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("has a `policies` line start.py cannot read");
  });
});
