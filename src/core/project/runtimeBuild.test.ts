import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStateError } from "../../errors";
import { ProjectRuntimeSchema, type ProjectRuntime } from "../../projectSchemas/runtime";
import { describeChange, prepareRuntimes, readTomlString, syncRuntimeBuild } from "./runtimeBuild";

const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

/** A project root holding the given files (path -> content; a trailing `/` makes a directory). */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runtime-build-"));
  roots.push(root);
  await mkdir(join(root, "app", "search"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      await mkdir(join(root, path), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** The entry `add runtime --language python` writes, with overrides. */
function runtime(overrides: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    name: "search",
    codeLocation: "app/search" as ProjectRuntime["codeLocation"],
    build: "CodeZip",
    runtimeVersion: "PYTHON_3_14",
    entrypoint: "main.py",
    protocol: "HTTP",
    ...overrides,
  };
}

const nodeRuntime = (overrides: Partial<ProjectRuntime> = {}) =>
  runtime({ runtimeVersion: "NODE_22", entrypoint: "main.js", ...overrides });

const pyproject = (requiresPython: string, extra = "") =>
  `[project]\nname = "search"\nrequires-python = "${requiresPython}"\n${extra}`;

const packageJson = (fields: Record<string, unknown>) =>
  JSON.stringify({ name: "search", ...fields });

describe("runtimeVersion from requires-python", () => {
  test.each([
    [">=3.12", "PYTHON_3_14"],
    [">=3.10,<3.13", "PYTHON_3_12"],
    ["==3.11.*", "PYTHON_3_11"],
    ["~=3.11", "PYTHON_3_14"],
    ["~=3.11.2", "PYTHON_3_11"],
    [">=3.12.4", "PYTHON_3_14"],
    ["<3.12", "PYTHON_3_11"],
    [">3.13", "PYTHON_3_14"],
    [">= 3.10, < 3.13", "PYTHON_3_12"],
    ["!=3.14.*", "PYTHON_3_13"],
    ["==3.12", "PYTHON_3_12"],
    ["<=3.10", "PYTHON_3_10"],
    [">=v3.12", "PYTHON_3_14"],
  ])("%s resolves to %s", async (specifier, expected) => {
    const root = await project({ "app/search/pyproject.toml": pyproject(specifier) });
    const sync = syncRuntimeBuild(runtime(), root);
    expect(sync.runtime.runtimeVersion).toBe(expected as never);
    expect(sync.changes).toEqual(
      expected === "PYTHON_3_14"
        ? []
        : [
            {
              field: "runtimeVersion",
              from: "PYTHON_3_14",
              to: expected,
              reason: `requires-python "${specifier}" in app/search/pyproject.toml`,
            },
          ],
    );
  });

  test("a version in agentcore.json that requires-python allows is kept", async () => {
    const root = await project({ "app/search/pyproject.toml": pyproject(">=3.10") });
    const sync = syncRuntimeBuild(runtime({ runtimeVersion: "PYTHON_3_12" }), root);
    expect(sync.runtime.runtimeVersion).toBe("PYTHON_3_12");
    expect(sync.changes).toEqual([]);
  });

  test("a version requires-python excludes is replaced with the highest it allows", async () => {
    const root = await project({ "app/search/pyproject.toml": pyproject("<3.12") });
    expect(syncRuntimeBuild(runtime({ runtimeVersion: "PYTHON_3_13" }), root).changes).toEqual([
      {
        field: "runtimeVersion",
        from: "PYTHON_3_13",
        to: "PYTHON_3_11",
        reason: 'requires-python "<3.12" in app/search/pyproject.toml',
      },
    ]);
  });

  test.each(['[project]\nname = "search"\n', pyproject("")])(
    "with no requires-python, the agentcore.json version is kept (the way to pin)",
    async (manifest) => {
      const root = await project({ "app/search/pyproject.toml": manifest });
      const sync = syncRuntimeBuild(runtime({ runtimeVersion: "PYTHON_3_11" }), root);
      expect(sync.runtime.runtimeVersion).toBe("PYTHON_3_11");
      expect(sync.changes).toEqual([]);
      expect(sync.warnings).toEqual([]);
    },
  );

  test("with neither, the latest version is used with a warning", async () => {
    const root = await project({});
    const sync = syncRuntimeBuild(runtime({ runtimeVersion: undefined }), root);
    expect(sync.runtime.runtimeVersion).toBe("PYTHON_3_14");
    expect(sync.warnings).toEqual([
      'runtime "search": no requires-python in pyproject.toml; using Python 3.14. ' +
        "Set requires-python (or runtimeVersion in agentcore.json) to pin a version.",
    ]);
  });

  test(">=3.15 matches no supported version", async () => {
    const root = await project({ "app/search/pyproject.toml": pyproject(">=3.15") });
    expect(() => syncRuntimeBuild(runtime(), root)).toThrow(
      new ProjectStateError(
        'runtime "search": requires-python ">=3.15" in app/search/pyproject.toml matches no ' +
          "supported Python version (supported: 3.10, 3.11, 3.12, 3.13, 3.14).",
      ),
    );
  });

  test.each(["3.12", ">=3.12.*", "~=3", ">=three", "===3.12.0", ">=3.12rc1"])(
    "%s is unparseable",
    async (specifier) => {
      const root = await project({ "app/search/pyproject.toml": pyproject(specifier) });
      expect(() => syncRuntimeBuild(runtime(), root)).toThrow(
        `cannot parse requires-python "${specifier}" in app/search/pyproject.toml`,
      );
    },
  );

  test("an unquoted value is an error", async () => {
    const root = await project({
      "app/search/pyproject.toml": "[project]\nrequires-python = >=3.12\n",
    });
    expect(() => syncRuntimeBuild(runtime(), root)).toThrow(
      "cannot parse requires-python >=3.12 in app/search/pyproject.toml",
    );
  });

  test("the manifest is found in a parent folder, up to the project root", async () => {
    const root = await project({ "pyproject.toml": pyproject("<3.13") });
    const sync = syncRuntimeBuild(runtime(), root);
    expect(sync.runtime.runtimeVersion).toBe("PYTHON_3_12");
    expect(sync.changes[0]?.reason).toBe('requires-python "<3.13" in pyproject.toml');
  });

  test.each([
    ['requires-python = ">=3.12"', ">=3.12"],
    ["requires-python = '>=3.11'", ">=3.11"],
    ['  requires-python="==3.13.*"   # pinned', "==3.13.*"],
    ['"requires-python" = ">=3.10"', ">=3.10"],
  ])("reads %s", (line, expected) => {
    expect(readTomlString(`[project]\n${line}\n`, "project", "requires-python")?.value).toBe(
      expected,
    );
  });

  test("reads a key only from its own table", () => {
    const text =
      '[tool.other]\nrequires-python = ">=3.10"\n\n[project]\nname = "x"\n\n[tool.uv]\n' +
      'requires-python = ">=3.11"\n';
    expect(readTomlString(text, "project", "requires-python")).toBeUndefined();
    expect(
      readTomlString(`[project]\nrequires-python = [">=3"]\n`, "project", "requires-python"),
    ).toEqual({ raw: '[">=3"]' });
  });
});

describe("runtimeVersion from engines.node", () => {
  test.each([
    [">=20", "NODE_22"],
    ["^20", "NODE_20"],
    ["18 || 20", "NODE_20"],
    ["20.x", "NODE_20"],
    ["~18.17", "NODE_18"],
  ])("%s resolves to %s", async (range, expected) => {
    const root = await project({
      "app/search/package.json": packageJson({ engines: { node: range } }),
    });
    expect(syncRuntimeBuild(nodeRuntime(), root).runtime.runtimeVersion).toBe(expected as never);
  });

  test("a version engines.node allows is kept; one it excludes is replaced", async () => {
    const root = await project({
      "app/search/package.json": packageJson({ engines: { node: ">=18" } }),
    });
    expect(syncRuntimeBuild(nodeRuntime({ runtimeVersion: "NODE_20" }), root).changes).toEqual([]);
    const narrowed = await project({
      "app/search/package.json": packageJson({ engines: { node: "^22" } }),
    });
    expect(
      syncRuntimeBuild(nodeRuntime({ runtimeVersion: "NODE_20" }), narrowed).runtime.runtimeVersion,
    ).toBe("NODE_22");
  });

  test(">=24 matches no supported version", async () => {
    const root = await project({
      "app/search/package.json": packageJson({ engines: { node: ">=24" } }),
    });
    expect(() => syncRuntimeBuild(nodeRuntime(), root)).toThrow(
      'engines.node ">=24" in app/search/package.json matches no supported Node.js version ' +
        "(supported: 18, 20, 22).",
    );
  });

  test.each(["node twenty", "^20.0.0-beta.1"])("%s is unparseable", async (range) => {
    const root = await project({
      "app/search/package.json": packageJson({ engines: { node: range } }),
    });
    expect(() => syncRuntimeBuild(nodeRuntime(), root)).toThrow(
      `cannot parse engines.node "${range}" in app/search/package.json`,
    );
  });

  test("a non-string engines.node or invalid package.json is an error", async () => {
    const numeric = await project({
      "app/search/package.json": packageJson({ engines: { node: 20 } }),
    });
    expect(() => syncRuntimeBuild(nodeRuntime(), numeric)).toThrow(
      "cannot parse engines.node 20 in app/search/package.json",
    );
    const broken = await project({ "app/search/package.json": "{" });
    expect(() => syncRuntimeBuild(nodeRuntime(), broken)).toThrow(
      "cannot parse app/search/package.json as JSON",
    );
  });

  test.each([{}, { engines: { node: "" } }])(
    "with no engines.node the agentcore.json version is kept",
    async (fields) => {
      const root = await project({ "app/search/package.json": packageJson(fields) });
      const sync = syncRuntimeBuild(nodeRuntime({ runtimeVersion: "NODE_18" }), root);
      expect(sync.runtime.runtimeVersion).toBe("NODE_18");
      expect(sync.changes).toEqual([]);
    },
  );
});

describe("build", () => {
  test("a Dockerfile switches to a Container build and drops runtimeVersion", async () => {
    const root = await project({ "app/search/Dockerfile": "FROM scratch\n" });
    const sync = syncRuntimeBuild(runtime(), root);
    expect(sync.runtime).toMatchObject({ build: "Container", dockerfile: "Dockerfile" });
    expect(sync.runtime.runtimeVersion).toBeUndefined();
    expect(sync.changes).toEqual([
      { field: "build", from: "CodeZip", to: "Container", reason: "Dockerfile in app/search" },
      { field: "dockerfile", to: "Dockerfile", reason: "Dockerfile in app/search" },
      { field: "runtimeVersion", from: "PYTHON_3_14", reason: "Container build" },
    ]);
    expect(describeChange("search", sync.changes[0]!)).toBe(
      "search: build CodeZip -> Container (Dockerfile in app/search). It now builds and " +
        "deploys as a container image from that Dockerfile; to go back, delete the Dockerfile, " +
        'then in agentcore.json set "build": "CodeZip", remove "dockerfile", and add back the ' +
        '"runtimeVersion" removed below.',
    );
  });

  test("a migrated Container runtime drops its runtimeVersion once, then stays put", async () => {
    const root = await project({ "app/search/Dockerfile": "FROM scratch\n" });
    const migrated = runtime({ build: "Container", dockerfile: "Dockerfile" });
    const first = syncRuntimeBuild(migrated, root);
    expect(first.changes).toEqual([
      { field: "runtimeVersion", from: "PYTHON_3_14", reason: "Container build" },
    ]);
    expect(syncRuntimeBuild(first.runtime, root).changes).toEqual([]);
  });

  test("a Container runtime whose Dockerfile is missing fails instead of switching", async () => {
    const root = await project({
      "app/search/main.py": "",
      "app/search/pyproject.toml": pyproject(">=3.10,<3.14"),
    });
    const container = runtime({
      build: "Container",
      dockerfile: "Dockerfile",
      runtimeVersion: undefined,
    });
    expect(syncRuntimeBuild(container, root).changes).toEqual([]);
    expect(() => prepareRuntimes(root, [container], "deploy")).toThrow(
      new ProjectStateError(
        'runtime "search": no Dockerfile in app/search/, and agentcore.json says this is a ' +
          "Container build. Add the Dockerfile, or deploy the code directly: in agentcore.json, " +
          'set "build": "CodeZip", remove "dockerfile", and add "runtimeVersion" (for example ' +
          '"PYTHON_3_14"). See app/search/README.md.',
      ),
    );
  });

  test("the precheck names every container-only field a runtime has to drop to go back", async () => {
    const root = await project({ "app/search/main.py": "", "docker/": "" });
    const container = runtime({
      build: "Container",
      dockerfile: "Dockerfile",
      buildContextPath: "docker" as ProjectRuntime["buildContextPath"],
      customDockerBuildArgs: { FOO: "bar" },
    });
    expect(() => prepareRuntimes(root, [container], "deploy")).toThrow(
      new ProjectStateError(
        'runtime "search": no Dockerfile in docker/, and agentcore.json says this is a ' +
          "Container build. Add the Dockerfile, or deploy the code directly: in agentcore.json, " +
          'set "build": "CodeZip", remove "dockerfile", "buildContextPath", ' +
          '"customDockerBuildArgs", and add "runtimeVersion" (for example "PYTHON_3_14"). ' +
          "See app/search/README.md.",
      ),
    );
  });

  test("following the go-back instructions yields a CodeZip runtime that loads", async () => {
    const root = await project({
      "app/search/Dockerfile": "FROM scratch\n",
      "app/search/main.py": "",
      "app/search/pyproject.toml": pyproject(">=3.10,<3.13"),
    });
    const container = syncRuntimeBuild(runtime(), root).runtime;
    expect(container.build).toBe("Container");
    await rm(join(root, "app/search/Dockerfile"));

    // "build" alone is what the old message said; the schema rejects it.
    expect(ProjectRuntimeSchema.safeParse({ ...container, build: "CodeZip" }).success).toBe(false);

    const { dockerfile: _removed, ...rest } = container;
    const reverted = ProjectRuntimeSchema.parse({
      ...rest,
      build: "CodeZip",
      runtimeVersion: "PYTHON_3_14",
    });
    const [prepared] = prepareRuntimes(root, [reverted], "deploy").changed;
    expect(prepared?.runtime).toMatchObject({ build: "CodeZip", runtimeVersion: "PYTHON_3_12" });
  });

  test("only a file named exactly Dockerfile counts", async () => {
    const root = await project({
      "app/search/dockerfile": "FROM scratch\n",
      "app/search/Dockerfile.dev": "FROM scratch\n",
    });
    expect(syncRuntimeBuild(runtime(), root).changes).toEqual([]);
  });

  test("a symlinked Dockerfile counts", async () => {
    const root = await project({ "app/search/docker/Dockerfile.real": "FROM scratch\n" });
    await symlink(join("docker", "Dockerfile.real"), join(root, "app", "search", "Dockerfile"));
    expect(syncRuntimeBuild(runtime(), root).runtime.build).toBe("Container");
  });

  test("the Dockerfile is looked up in buildContextPath when set", async () => {
    const root = await project({ "app/Dockerfile": "FROM scratch\n" });
    const sync = syncRuntimeBuild(
      runtime({ build: "Container", buildContextPath: "app" as never, runtimeVersion: undefined }),
      root,
    );
    expect(sync.runtime).toMatchObject({ build: "Container", dockerfile: "Dockerfile" });
  });

  test("a custom dockerfile path keeps the build Container", async () => {
    const root = await project({ "app/search/docker/Prod.Dockerfile": "FROM scratch\n" });
    const custom = runtime({
      build: "Container",
      dockerfile: "docker/Prod.Dockerfile",
      runtimeVersion: undefined,
    });
    expect(syncRuntimeBuild(custom, root).changes).toEqual([]);
  });

  test("a Container build with buildContextPath and no Dockerfile names the folder", async () => {
    const root = await project({});
    const container = runtime({
      build: "Container",
      buildContextPath: "app" as never,
      runtimeVersion: undefined,
    });
    expect(() => prepareRuntimes(root, [container], "deploy")).toThrow(
      'runtime "search": no Dockerfile in app/, and agentcore.json says this is a Container build.',
    );
  });
});

describe("entrypoint", () => {
  test("[tool.agentcore] entrypoint in pyproject.toml wins", async () => {
    const root = await project({
      "app/search/pyproject.toml": pyproject(
        ">=3.12",
        '\n[tool.agentcore]\nentrypoint = "agent.py:app"\n',
      ),
    });
    const sync = syncRuntimeBuild(runtime(), root);
    expect(sync.runtime.entrypoint).toBe("agent.py:app");
    expect(sync.changes).toEqual([
      {
        field: "entrypoint",
        from: "main.py",
        to: "agent.py:app",
        reason: "[tool.agentcore] entrypoint in app/search/pyproject.toml",
      },
    ]);
  });

  test("without [tool.agentcore] the agentcore.json entrypoint is kept", async () => {
    const root = await project({ "app/search/pyproject.toml": pyproject(">=3.12") });
    expect(syncRuntimeBuild(runtime({ entrypoint: "server.py" }), root).runtime.entrypoint).toBe(
      "server.py",
    );
  });

  test("a non-Python [tool.agentcore] entrypoint is an error", async () => {
    const root = await project({
      "app/search/pyproject.toml": '[tool.agentcore]\nentrypoint = "main.ts"\n',
    });
    expect(() => syncRuntimeBuild(runtime(), root)).toThrow(
      '[tool.agentcore] entrypoint "main.ts" in app/search/pyproject.toml is not a Python file path',
    );
  });

  test.each(["main.ts", "./main.ts", "main.js", "./main.js"])(
    'package.json "main" %s is stored as main.js',
    async (main) => {
      const root = await project({ "app/search/package.json": packageJson({ main }) });
      const sync = syncRuntimeBuild(nodeRuntime({ entrypoint: "main.ts" }), root);
      expect(sync.runtime.entrypoint).toBe("main.js");
    },
  );

  test.each(["src/index.ts", "dist/main.js", "index.js"])(
    'package.json "main" %s is ignored with a warning on a CodeZip build',
    async (main) => {
      const root = await project({ "app/search/package.json": packageJson({ main }) });
      const sync = syncRuntimeBuild(nodeRuntime(), root);
      expect(sync.runtime.entrypoint).toBe("main.js");
      expect(sync.changes).toEqual([]);
      expect(sync.warnings).toEqual([
        `runtime "search": package.json "main" is "${main}"; AgentCore currently bundles main.ts ` +
          'at the root of app/search, so "main" is ignored.',
      ]);
    },
  );

  test('package.json "main" is not read for a Container build', async () => {
    const root = await project({
      "app/search/Dockerfile": "FROM node:22\n",
      "app/search/package.json": packageJson({ main: "dist/main.js" }),
    });
    const container = nodeRuntime({
      build: "Container",
      dockerfile: "Dockerfile",
      runtimeVersion: undefined,
      entrypoint: "dist/main.js",
    });
    const sync = syncRuntimeBuild(container, root);
    expect(sync.changes).toEqual([]);
    expect(sync.warnings).toEqual([]);
  });

  test.each([
    '[tool]\nagentcore.entrypoint = "server.py"\n',
    'tool.agentcore.entrypoint = "server.py"\n',
    '[tool]\nagentcore = { entrypoint = "server.py" }\n',
  ])("warns about an agentcore entrypoint form it does not read: %p", async (toml) => {
    const root = await project({ "app/search/pyproject.toml": toml });
    const sync = syncRuntimeBuild(runtime(), root);
    expect(sync.runtime.entrypoint).toBe("main.py");
    expect(sync.warnings).toEqual([
      'runtime "search": app/search/pyproject.toml sets the agentcore entrypoint in a form the ' +
        "CLI does not read; it is ignored. Use a [tool.agentcore] table with " +
        'entrypoint = "main.py" on one line.',
    ]);
  });
});

describe("prepareRuntimes", () => {
  test("runtimes that already match their code are left alone, with no output", async () => {
    const root = await project({
      "app/search/pyproject.toml": pyproject(">=3.12"),
      "app/search/main.py": "",
    });
    expect(prepareRuntimes(root, [runtime()], "deploy")).toEqual({
      runtimes: [runtime()],
      changed: [],
      messages: [],
    });
  });

  test("a changed runtime is reported field by field", async () => {
    const root = await project({
      "app/search/pyproject.toml": pyproject(">=3.10,<3.13"),
      "app/search/main.py": "",
    });
    const prepared = prepareRuntimes(root, [runtime()], "deploy");
    expect(prepared.changed).toHaveLength(1);
    expect(prepared.messages).toEqual([
      'search: runtimeVersion PYTHON_3_14 -> PYTHON_3_12 (requires-python ">=3.10,<3.13" in ' +
        "app/search/pyproject.toml)",
    ]);
  });

  test.each<[string, Record<string, string>, Partial<ProjectRuntime>, string[]]>([
    [
      "Python without a manifest or entrypoint",
      {},
      {},
      ["no pyproject.toml in app/search/.", "no main.py in app/search/."],
    ],
    [
      "Python with a package.json instead",
      { "app/search/package.json": "{}", "app/search/main.py": "" },
      {},
      ["this runtime is Python (entrypoint main.py) but app/search/ has a package.json"],
    ],
    [
      "TypeScript without package.json, main.ts, or node_modules",
      {},
      { runtimeVersion: "NODE_22", entrypoint: "main.js" },
      [
        "no package.json in app/search/.",
        "no main.ts in app/search/.",
        "no node_modules in app/search/; run `npm install` there.",
      ],
    ],
    [
      "TypeScript with a pyproject.toml instead",
      { "app/search/pyproject.toml": "", "app/search/main.ts": "", "app/search/node_modules/": "" },
      { runtimeVersion: "NODE_22", entrypoint: "main.js" },
      ["this runtime is TypeScript (entrypoint main.js) but app/search/ has a pyproject.toml"],
    ],
    [
      "a custom dockerfile that is missing",
      {},
      { build: "Container", dockerfile: "docker/Prod.Dockerfile", runtimeVersion: undefined },
      ["no Dockerfile at app/search/docker/Prod.Dockerfile, and agentcore.json says"],
    ],
    [
      "a Container build in VPC mode without vpcId",
      { "app/search/Dockerfile": "" },
      {
        networkMode: "VPC",
        networkConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: ["sg-0123456789abcdef0"],
        },
      },
      ["networkConfig.vpcId is required for Container builds in VPC mode"],
    ],
    [
      "a missing code folder",
      {},
      { codeLocation: "app/missing" as never },
      ["app/missing/ does not exist."],
    ],
    [
      "an unsupported requires-python",
      { "app/search/pyproject.toml": pyproject(">=3.15"), "app/search/main.py": "" },
      {},
      ['requires-python ">=3.15" in app/search/pyproject.toml matches no supported Python version'],
    ],
  ])("fails early for %s", async (_label, files, overrides, expected) => {
    const root = await project(files);
    let error: unknown;
    try {
      prepareRuntimes(root, [runtime(overrides)], "deploy");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProjectStateError);
    const lines = (error as Error).message.split("\n");
    expect(lines).toHaveLength(expected.length);
    expected.forEach((fragment, i) => {
      expect(lines[i]).toStartWith('runtime "search":');
      expect(lines[i]).toContain(fragment);
      expect(lines[i]).toEndWith(`See ${overrides.codeLocation ?? "app/search"}/README.md.`);
    });
  });

  test("deploy requires main.ts even when a main.js exists; dev runs the JavaScript", async () => {
    const root = await project({
      "app/search/package.json": packageJson({ engines: { node: "^20" } }),
      "app/search/main.js": "",
      "app/search/node_modules/": "",
    });
    expect(() => prepareRuntimes(root, [nodeRuntime()], "deploy")).toThrow(
      "no main.ts in app/search/.",
    );
    expect(prepareRuntimes(root, [nodeRuntime()], "dev").runtimes[0]?.runtimeVersion).toBe(
      "NODE_20",
    );
  });

  test("dev does not require node_modules, which it installs itself", async () => {
    const root = await project({
      "app/search/package.json": packageJson({}),
      "app/search/main.ts": "",
    });
    expect(prepareRuntimes(root, [nodeRuntime()], "dev").changed).toEqual([]);
    expect(() => prepareRuntimes(root, [nodeRuntime()], "deploy")).toThrow("no node_modules");
  });
});
