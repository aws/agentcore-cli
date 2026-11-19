import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import type { ProjectSpec } from "../../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import { profileKeyPlaces, runtimeProfileContext } from "../context";
import { deriveRuntimeProfile } from "../derive";
import { serializeRuntimeProfile } from "../serialize";
import type { TomlTable } from "../types";
import { apply } from "./paths";

const CODEZIP = {
  name: "agent",
  build: "CodeZip",
  entrypoint: "start.py",
  codeLocation: "app/agent",
  protocol: "HTTP",
  modelProvider: "Bedrock",
  box: { version: "1.0.0" },
} as ProjectRuntime;
const CONTAINER = { ...CODEZIP, build: "Container", entrypoint: "main.py" } as ProjectRuntime;
const PROFILE = ".box/agent/local/profile.toml";

const contextOf = (text: string, runtime: ProjectRuntime = CODEZIP) =>
  runtimeProfileContext({
    spec: { name: "demo", runtimes: [runtime] } as unknown as ProjectSpec,
    runtime,
    profileFile: PROFILE,
    region: "us-west-2",
    gateway: { name: "agent-box-egress", targets: [] },
    hosts: [],
    telemetry: [],
    policyFiles: [],
    places: profileKeyPlaces(text, PROFILE),
  });

/** The table of the paths rule for the local profile `text`. */
const moved = (text: string, runtime: ProjectRuntime = CODEZIP) => {
  const result = apply(parse(text) as TomlTable, contextOf(text, runtime));
  expect(result.problems).toEqual([]);
  expect(result.warnings).toEqual([]);
  return result.table;
};

const toml = (...lines: string[]) => lines.join("\n");

const APP = "${{ workspace }}/app/agent";
const CODE = "${{ inputs.code.dir }}";
const PYTHON = "${{ inputs.python.path }}";
const PREFIX = "${{ inputs.python.prefix }}";
const PYTHONPATH = `${CODE}/.box-dist/ffi:${CODE}`;

/** A local profile with a stdio MCP server and a tool, each with a key build does not know. */
const LEAVES = toml(
  'packs = ["box/base"]',
  "",
  "[agent]",
  'command = ["/bin/echo"]',
  "",
  "[mcp.notes]",
  'type = "stdio"',
  `command = ["${APP}/.venv/bin/python3.15", "${APP}/notes_server.py", "--root=${APP}/notes"]`,
  `workspace = "${APP}"`,
  "argument_wildcards = true",
  `env = { NOTES_DIR = "\${{workspace}}/app/agent/notes", LEVEL = "debug" }`,
  "",
  "[mcp.notes.filesystem]",
  `read = ["${APP}", { path = "${APP}/.venv", optional = true }, { path = "\${{ home }}/.local/share/uv/python", optional = true }]`,
  `write = ["${APP}/notes/out"]`,
  "",
  "[mcp.notes.network]",
  "contain_egress = true",
  "",
  "[tool.lister]",
  `command = ["${APP}/bin/lister", "--all"]`,
  "native-filesystem-policy = false",
  "",
  "[tool.lister.filesystem]",
  `read = ["${APP}/data"]`,
);

/** {@link LEAVES} on a CodeZip Runtime. */
const LEAVES_ON_RUNTIME = {
  notes: {
    type: "stdio",
    command: [PYTHON, `${CODE}/notes_server.py`, `--root=${CODE}/notes`],
    workspace: CODE,
    argument_wildcards: true,
    // The Runtime's Python finds the dependencies in the code folder, as the agent does.
    env: { NOTES_DIR: `${CODE}/notes`, LEVEL: "debug", PYTHONPATH },
    // The venv moves to the code folder, which the first grant names already.
    filesystem: {
      read: [CODE, { path: PREFIX, optional: true }],
      write: [`${CODE}/notes/out`],
    },
    network: { contain_egress: true },
  },
  lister: {
    command: [`${CODE}/bin/lister`, "--all"],
    "native-filesystem-policy": false,
    filesystem: { read: [`${CODE}/data`] },
  },
};

describe("the paths rule", () => {
  test("keeps each stdio [mcp] server and each [tool], with each key, in the Runtime profile", () => {
    // Today renderRuntimeBoxProfile builds the Runtime profile from agentcore.json, and it has no
    // [mcp.notes] and no [tool.lister]. The derived profile keeps both, as they work there.
    const { profile, problems } = deriveRuntimeProfile(
      parse(LEAVES) as TomlTable,
      contextOf(LEAVES),
    );
    const written = parse(serializeRuntimeProfile(profile)) as TomlTable;

    expect(problems).toEqual([]);
    expect(written.mcp).toEqual({ notes: LEAVES_ON_RUNTIME.notes });
    expect(written.tool).toEqual({ lister: LEAVES_ON_RUNTIME.lister });
  });

  test("moves the venv's Python, the venv, the uv Pythons, and the code folder in [agent]", () => {
    const table = moved(
      toml(
        'agent-args = ["--config", "${{ workspace }}/app/agent/agent.json"]',
        "[agent]",
        `command = ["${APP}/.venv/bin/python", "-m", "main"]`,
        `workspace = "${APP}"`,
        "[agent.env]",
        `PYTHONPATH = "${APP}/src:${APP}"`,
        `PYTHON = "${APP}/.venv/bin/python3"`,
        'LEVEL = "debug"',
        "[agent.filesystem]",
        `read = ["${APP}", { path = "${APP}/.venv", optional = true }, { path = "\${{ home }}/.local/share/uv/python", optional = true }]`,
        `exec = [{ path = "${APP}/.venv", optional = true }, { path = "\${{ home }}/.local/share/uv/python", optional = true }]`,
        `write_file = ["${APP}/out.json"]`,
      ),
    );

    expect(table).toEqual({
      "agent-args": ["--config", `${CODE}/agent.json`],
      agent: {
        command: [PYTHON, "-m", "main"],
        workspace: CODE,
        // The agent's own PYTHONPATH is the additions rule's: this rule adds none to [agent].
        env: { PYTHONPATH: `${CODE}/src:${CODE}`, PYTHON, LEVEL: "debug" },
        filesystem: {
          read: [CODE, { path: PREFIX, optional: true }],
          exec: [
            { path: CODE, optional: true },
            { path: PREFIX, optional: true },
          ],
          write_file: [`${CODE}/out.json`],
        },
      },
    });
  });

  test("keeps the grant that is not optional where two grants move to one path", () => {
    const table = moved(
      toml(
        "[tool.lister]",
        `command = ["${APP}/lister"]`,
        "[tool.lister.filesystem]",
        `read = [{ path = "${APP}/.venv", optional = true }, "${APP}/data", "${APP}", { path = "${APP}", when = "macos" }]`,
      ),
    );

    expect((table.tool as { lister: TomlTable }).lister.filesystem).toEqual({
      read: [CODE, `${CODE}/data`, { path: CODE, when: "macos" }],
    });
  });

  test("puts the _ctypes folder in front of a leaf's own PYTHONPATH, and adds none to [agent] or a leaf with no Python", () => {
    const table = moved(
      toml(
        "[agent]",
        `command = ["${APP}/.venv/bin/python", "-m", "main"]`,
        "[mcp.notes]",
        'type = "stdio"',
        `command = ["${APP}/.venv/bin/python3.12", "-m", "notes"]`,
        `env = { PYTHONPATH = "${APP}/src:${APP}" }`,
        "[tool.lister]",
        `command = ["${APP}/bin/lister"]`,
      ),
    );

    expect(table).toEqual({
      agent: { command: [PYTHON, "-m", "main"] },
      mcp: {
        notes: {
          type: "stdio",
          command: [PYTHON, "-m", "notes"],
          env: { PYTHONPATH: `${CODE}/.box-dist/ffi:${CODE}/src:${CODE}` },
        },
      },
      tool: { lister: { command: [`${CODE}/bin/lister`] } },
    });
  });

  test("moves each project path of a path list behind the _ctypes entry, and keeps that entry", () => {
    // The additions rule puts the _ctypes folder in front of the user's own [agent] PYTHONPATH.
    const ffi = `${CODE}/.box-dist/ffi`;
    const text = toml(
      "[agent]",
      'command = ["${{ inputs.python.path }}", "-m", "main"]',
      "[agent.env]",
      `PYTHONPATH = "${ffi}:${APP}/src:${APP}"`,
      "[mcp.notes]",
      'type = "stdio"',
      `command = ["${APP}/.venv/bin/python3.15", "-m", "notes"]`,
      `env = { PYTHONPATH = "${ffi}:${APP}/lib:${APP}" }`,
    );

    expect(moved(text)).toEqual({
      agent: {
        command: [PYTHON, "-m", "main"],
        env: { PYTHONPATH: `${ffi}:${CODE}/src:${CODE}` },
      },
      mcp: {
        notes: {
          type: "stdio",
          command: [PYTHON, "-m", "notes"],
          env: { PYTHONPATH: `${ffi}:${CODE}/lib:${CODE}` },
        },
      },
    });
  });

  test("moves the paths of a code folder that is the project folder", () => {
    const root = { ...CODEZIP, codeLocation: "." } as ProjectRuntime;
    const text = toml(
      "[tool.lister]",
      'command = ["${{ workspace }}/.venv/bin/python3.15", "${{ workspace }}/lister.py"]',
    );

    expect(moved(text, root)).toEqual({
      tool: { lister: { command: [PYTHON, `${CODE}/lister.py`], env: { PYTHONPATH } } },
    });
  });

  test("changes no key that another rule writes, and no value with no path of the project", () => {
    const text = toml(
      'packs = ["box/base"]',
      'policies = ["policies/app.dw"]',
      "[profile]",
      'name = "demo-agent"',
      "[options]",
      'bedrock.region = "us-west-2"',
      "[egress.files]",
      'destinations = ["files.example.com"]',
      'secret.ref = "file://${{ workspace }}/app/agent/.files-token"',
      "[mcp.docs]",
      'type = "http"',
      'destinations = ["docs.example.com"]',
      'secret.ref = "file://${{ workspace }}/app/agent/.docs-token"',
      "[telemetry.local]",
      'kind = "file"',
      'path = "${{ workspace }}/app/agent/telemetry.jsonl"',
      "[agent]",
      'command = ["/usr/bin/env", "--flag", "${{ inputs.code.dir }}/x", "https://example.com/a:b"]',
      "[[agent.ingress]]",
      'listen = "127.0.0.1:8080"',
      "workload_port = 8081",
      "[limits.shell]",
      "timeout = 30",
    );

    expect(moved(text)).toEqual(parse(text) as TomlTable);
  });

  test("keeps each path of a container image, which runs the same paths under dev and on the Runtime", () => {
    const text = toml(
      LEAVES,
      "[agent.filesystem]",
      'read = ["${{ workspace }}", "${{workspace}}/.venv", "${{ workspace }}", "${{ home }}/.aws"]',
      "[tool.image]",
      'command = ["${{ workspace }}/.venv/bin/python", "${{ workspace }}/image.py"]',
    );

    expect(moved(text, CONTAINER)).toEqual(parse(text) as TomlTable);
  });

  test.each(["HTTP", "A2A", "MCP", "AGUI"])(
    "moves each path of the profile that create writes for a %s runtime to the Runtime's inputs",
    (protocol) => {
      const context = contextOf("", { ...CODEZIP, protocol } as ProjectRuntime);

      const text = serializeRuntimeProfile(apply(context.template.local, context).table);

      expect(text).toContain(CODE);
      expect(text).not.toContain("${{ workspace }}");
      expect(text).not.toContain("${{ home }}");
    },
  );

  test("changes no table it gets", () => {
    const local = parse(LEAVES) as TomlTable;
    const frozen = structuredClone(local);

    const { table } = apply(local, contextOf(LEAVES));
    ((table.mcp as TomlTable).notes as TomlTable).type = "changed";

    expect(local).toEqual(frozen);
  });
});
