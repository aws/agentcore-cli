import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import type { ProjectSpec } from "../../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import { profileKeyPlaces, runtimeProfileContext } from "../context";
import { deriveRuntimeProfile } from "../derive";
import type { RuntimeProfileProblem, TomlTable } from "../types";
import { apply } from "./refusals";

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

/** The problems of the refusals rule for the local profile `text`. */
const problemsOf = (text: string, runtime: ProjectRuntime = CODEZIP) =>
  apply(parse(text) as TomlTable, contextOf(text, runtime)).problems;

const toml = (...lines: string[]) => lines.join("\n");

/** The place of the line of `text` that starts with `start`. */
const lineOf = (text: string, start: string) =>
  `${PROFILE}:${text.split("\n").findIndex((line) => line.startsWith(start)) + 1}:1`;

const APP = "${{ workspace }}/app/agent";

/** A local profile that can go to a CodeZip Runtime: each path moves, and each program is there. */
const WORKS = toml(
  'packs = ["box/base", "box/bedrock"]',
  "",
  "[agent]",
  `command = ["${APP}/.venv/bin/python", "-m", "uvicorn", "main:app", "--app-dir", "${APP}"]`,
  "",
  "[agent.filesystem]",
  `read = ["${APP}", { path = "\${{ home }}/.local/share/uv/python", optional = true }]`,
  "",
  "[mcp.notes]",
  'type = "stdio"',
  `command = ["${APP}/.venv/bin/python3.15", "${APP}/notes_server.py"]`,
  "argument_wildcards = true",
  "",
  "[mcp.notes.network]",
  "contain_egress = true",
  "",
  "[mcp.docs]",
  'type = "http"',
  'destinations = ["docs.example.com"]',
  "",
  "[tool.lister]",
  `command = ["${APP}/bin/lister"]`,
  "",
  "[telemetry.logs]",
  'kind = "cloudwatch_logs"',
  'log_group = "/demo/agent"',
  'log_stream = "box"',
  "",
  "[telemetry.traces]",
  'kind = "cloudwatch_traces"',
);

describe("the refusals rule", () => {
  test.each([CODEZIP, CONTAINER])(
    "gives the table as it got it, with no problem, when each key can work ($build)",
    (runtime) => {
      const local = parse(WORKS) as TomlTable;

      const result = apply(local, contextOf(WORKS, runtime));

      expect(result).toEqual({ table: local, problems: [], warnings: [] });
      expect(result.table).not.toBe(local);
    },
  );

  test.each([
    [
      "a path of the project outside the code folder",
      ["mcp", "notes", "command"],
      `command = ["${APP}/.venv/bin/python3.15", "\${{ workspace }}/tools/notes.py"]`,
      '[mcp.notes] command names "${{ workspace }}/tools/notes.py", which is not in app/agent/. ' +
        "The zip of a CodeZip deploy contains only that folder. Move the file into app/agent/, " +
        "or remove the path.",
    ],
    [
      "a path of the home folder",
      ["mcp", "notes", "env", "NOTES_DIR"],
      'env = { NOTES_DIR = "${{ home }}/notes" }',
      '[mcp.notes.env] NOTES_DIR names "${{ home }}/notes" in the home folder. The home folder ' +
        "on AgentCore Runtime is empty. Move the file into app/agent/, or remove the path.",
    ],
    [
      "a path in the venv",
      ["mcp", "notes", "command"],
      `command = ["${APP}/.venv/bin/notes-server"]`,
      `[mcp.notes] command names "${APP}/.venv/bin/notes-server", a path in the venv. The zip of ` +
        "a CodeZip deploy does not contain the venv: the Runtime installs the dependencies in " +
        "app/agent/. Use the venv's Python, the venv, or a path in app/agent/.",
    ],
    [
      "a program in the venv whose name starts as the venv's Python does",
      ["mcp", "notes", "command"],
      `command = ["${APP}/.venv/bin/python3.15-config"]`,
      `[mcp.notes] command names "${APP}/.venv/bin/python3.15-config", a path in the venv. The ` +
        "zip of a CodeZip deploy does not contain the venv: the Runtime installs the dependencies " +
        "in app/agent/. Use the venv's Python, the venv, or a path in app/agent/.",
    ],
    [
      "a folder of the project whose name starts as the code folder's does",
      ["mcp", "notes", "command"],
      'command = ["${{ workspace }}/app/agent-tools/notes-server"]',
      '[mcp.notes] command names "${{ workspace }}/app/agent-tools/notes-server", which is not in ' +
        "app/agent/. The zip of a CodeZip deploy contains only that folder. Move the file into " +
        "app/agent/, or remove the path.",
    ],
  ])("stops for %s (RUNTIME_PATH_NOT_FOUND)", (_label, key, line, reason) => {
    const text = toml("[mcp.notes]", 'type = "stdio"', line);

    expect(problemsOf(text)).toEqual([
      { code: "RUNTIME_PATH_NOT_FOUND", key, reason, place: `${PROFILE}:3:1` },
    ]);
  });

  test("stops for each path that cannot move, in [agent], a [tool], and a filesystem list", () => {
    const text = toml(
      "[agent]",
      `command = ["${APP}/.venv/bin/python", "-m", "main"]`,
      "[agent.env]",
      'AWS_CONFIG_FILE = "${{ home }}/.aws/config"',
      "[agent.filesystem]",
      `read = ["${APP}", { path = "\${{ home }}/.aws", optional = true }]`,
      "[tool.lister]",
      `command = ["${APP}/bin/lister"]`,
      "[tool.lister.filesystem]",
      'write = ["${{ workspace }}/out", "${{ home }}/.local/share/uv/python/cpython-3.15"]',
    );

    expect(problemsOf(text).map(({ key, place }) => [key.join("."), place])).toEqual([
      ["agent.env.AWS_CONFIG_FILE", `${PROFILE}:4:1`],
      ["agent.filesystem.read", `${PROFILE}:6:1`],
      ["tool.lister.filesystem.write", `${PROFILE}:10:1`],
      ["tool.lister.filesystem.write", `${PROFILE}:10:1`],
    ]);
  });

  test.each([
    ["a program that PATH finds", ["mcp", "files"], '"npx", "-y", "files-server"', "npx"],
    ["a system program", ["tool", "grep"], '"/usr/bin/grep", "-r"', "/usr/bin/grep"],
  ])(
    "stops for %s that build cannot find on a CodeZip Runtime (RUNTIME_PROGRAM_NOT_FOUND)",
    (_label, table, command, program) => {
      const header = `[${table.join(".")}]`;
      const text = toml(
        header,
        ...(table[0] === "mcp" ? ['type = "stdio"'] : []),
        `command = [${command}]`,
      );

      expect(problemsOf(text)).toEqual([
        {
          code: "RUNTIME_PROGRAM_NOT_FOUND",
          key: [...table, "command"],
          reason:
            `${header} command starts "${program}", which build cannot find on AgentCore ` +
            "Runtime. The zip of a CodeZip deploy contains only app/agent/, and the Runtime has " +
            "its own Python. Start the process with the venv's Python, for example " +
            `${APP}/.venv/bin/python3.<minor>, or with a program in app/agent/.`,
          place: lineOf(text, "command"),
        },
      ]);
      expect(problemsOf(text, CONTAINER)).toEqual([]);
    },
  );

  test("stops for a [tool] program that box finds on PATH, on a CodeZip Runtime only", () => {
    const text = toml("[tool.jq]", 'program = "jq"');

    expect(problemsOf(text).map(({ code, key }) => [code, key])).toEqual([
      ["RUNTIME_PROGRAM_NOT_FOUND", ["tool", "jq", "program"]],
    ]);
    expect(problemsOf(text, CONTAINER)).toEqual([]);
  });

  test("gives one problem, of the path, for a program with no place on the Runtime", () => {
    const text = toml("[tool.lister]", 'command = ["${{ home }}/bin/lister"]');

    expect(problemsOf(text).map(({ code }) => code)).toEqual(["RUNTIME_PATH_NOT_FOUND"]);
  });

  test.each([
    ["mcp", 'type = "stdio"\ncommand = ["${{ workspace }}/app/agent/notes-server"]'],
    ["tool", 'command = ["${{ workspace }}/app/agent/notes-server"]'],
    ["agent", 'command = ["${{ workspace }}/app/agent/notes-server"]'],
  ])(
    "stops for contain_egress = false in [%s], for CodeZip and a container (RUNTIME_EGRESS_NOT_CONTAINED)",
    (group, body) => {
      const table = group === "agent" ? "agent" : `${group}.notes`;
      const text = toml(`[${table}]`, body, `[${table}.network]`, "contain_egress = false");
      const expected: RuntimeProfileProblem = {
        code: "RUNTIME_EGRESS_NOT_CONTAINED",
        key: [...table.split("."), "network", "contain_egress"],
        reason:
          `[${table}.network] contain_egress is false: on AgentCore Runtime, [${table}] connects ` +
          "to hosts without the Box gateway. Build does not send such a process to AgentCore " +
          "Runtime. Remove contain_egress, and give each host that the process connects to an " +
          "[egress] entry.",
        place: lineOf(text, "contain_egress"),
      };

      expect(problemsOf(text)).toEqual([expected]);
      expect(problemsOf(text, CONTAINER)).toEqual([expected]);
    },
  );

  test.each([CODEZIP, CONTAINER])(
    "stops for each [telemetry] target that is not CloudWatch, by its kind ($build)",
    (runtime) => {
      const text = toml(
        "[telemetry.logs]",
        'kind = "cloudwatch_logs"',
        'log_group = "/demo/agent"',
        'log_stream = "box"',
        "",
        "[telemetry.collector]",
        'kind = "otlp"',
        'endpoint = "https://otel.example.com"',
        "",
        "[telemetry.local]",
        'path = "/tmp/box.jsonl"',
      );

      expect(problemsOf(text, runtime)).toEqual([
        {
          code: "RUNTIME_TELEMETRY_NOT_CLOUDWATCH",
          key: ["telemetry", "collector", "kind"],
          reason:
            '[telemetry.collector] kind is "otlp". At this time, a box on AgentCore Runtime can ' +
            'send telemetry only to CloudWatch: kind "cloudwatch_logs" or "cloudwatch_traces". ' +
            "Remove [telemetry.collector], or change its kind to one of these.",
          place: `${PROFILE}:7:1`,
        },
        {
          code: "RUNTIME_TELEMETRY_NOT_CLOUDWATCH",
          key: ["telemetry", "local", "kind"],
          reason:
            "[telemetry.local] kind is not set. At this time, a box on AgentCore Runtime can send " +
            'telemetry only to CloudWatch: kind "cloudwatch_logs" or "cloudwatch_traces". Remove ' +
            "[telemetry.local], or change its kind to one of these.",
          place: `${PROFILE}:10:1`,
        },
      ]);
    },
  );

  test("reads no path of [egress], of an HTTP [mcp], or of [telemetry]: other rules write them", () => {
    const text = toml(
      "[egress.files]",
      'destinations = ["files.example.com"]',
      'secret.ref = "file://${{ home }}/.files-token"',
      "[mcp.docs]",
      'type = "http"',
      'destinations = ["docs.example.com"]',
      'secret.ref = "file://${{ home }}/.docs-token"',
      "[telemetry.traces]",
      'kind = "cloudwatch_traces"',
      'note = "${{ home }}/traces"',
    );

    expect(problemsOf(text)).toEqual([]);
  });

  test.each(["HTTP", "A2A", "MCP", "AGUI"])(
    "finds no problem in each profile that create writes for a %s runtime",
    (protocol) => {
      for (const build of [CODEZIP, CONTAINER]) {
        const context = contextOf("", { ...build, protocol } as ProjectRuntime);

        expect(apply(context.template.local, context).problems).toEqual([]);
      }
    },
  );

  test("reads the local profile as the user wrote it: the first rule of the derivation", () => {
    const text = toml("[mcp.files]", 'type = "stdio"', 'command = ["npx", "files-server"]');

    const { problems } = deriveRuntimeProfile(parse(text) as TomlTable, contextOf(text));

    expect(problems.map(({ code, place }) => [code, place])).toEqual([
      ["RUNTIME_PROGRAM_NOT_FOUND", `${PROFILE}:3:1`],
    ]);
  });
});
