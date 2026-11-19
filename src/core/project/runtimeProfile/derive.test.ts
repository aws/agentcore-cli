import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { profileKeyPlaces, runtimePaths, runtimeProfileContext, runtimeTemplate } from "./context";
import { deriveRuntimeProfile, keyLabel, RUNTIME_PROFILE_RULES } from "./derive";
import { serializeRuntimeProfile } from "./serialize";
import type { TomlTable } from "./types";

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
const SPEC = { name: "demo", runtimes: [CODEZIP] } as unknown as ProjectSpec;

const context = (runtime: ProjectRuntime, places = new Map<string, string>()) =>
  runtimeProfileContext({
    spec: SPEC,
    runtime,
    profileFile: ".box/agent/local/profile.toml",
    region: "us-west-2",
    gateway: { name: "agent-box-egress", targets: [] },
    hosts: [],
    telemetry: [],
    policyFiles: [],
    places,
  });

/** The keys of a profile that no rule of the derivation changes, as box 0.1.11-linux-preview.6 takes them. */
const CARRIED: TomlTable = {
  "agent-args": ["--verbose"],
  "file-attributes": true,
  limits: { shell: { timeout: 30 } },
  "experimental-features": { "native-filesystem-policy": true },
  project: { access: "read" },
};

describe("deriveRuntimeProfile", () => {
  test("runs the rules in their order: refusals, gateway, additions, then paths", () => {
    expect(RUNTIME_PROFILE_RULES.map(({ name }) => name)).toEqual([
      "refusals",
      "gateway",
      "additions",
      "paths",
    ]);
  });

  test.each([CODEZIP, CONTAINER])(
    "carries each key that no rule changes as the local profile has it ($build)",
    (runtime) => {
      const local = { packs: ["@box/base"], ...CARRIED, agent: { command: ["/bin/echo"] } };

      const { profile, problems } = deriveRuntimeProfile(local, context(runtime));

      expect(problems).toEqual([]);
      for (const [key, value] of Object.entries(CARRIED)) expect(profile[key]).toEqual(value);
    },
  );

  test("changes no table it gets", () => {
    const local = structuredClone({
      ...CARRIED,
      mcp: { notes: { type: "stdio", command: ["x"] } },
    });
    const frozen = structuredClone(local);

    deriveRuntimeProfile(local, context(CODEZIP));

    expect(local).toEqual(frozen);
  });
});

describe("runtimePaths", () => {
  test("moves a CodeZip runtime's code and Python to the inputs of @box/agentcore-codezip", () => {
    expect(runtimePaths(CODEZIP)).toEqual({
      build: "CodeZip",
      localCode: "${{ workspace }}/app/agent",
      localVenv: "${{ workspace }}/app/agent/.venv",
      localPythons: "${{ home }}/.local/share/uv/python",
      runtimeCode: "${{ inputs.code.dir }}",
      runtimePython: "${{ inputs.python.path }}",
      runtimePythonPrefix: "${{ inputs.python.prefix }}",
      shownCode: "app/agent/",
    });
    expect(
      runtimePaths({ ...CODEZIP, codeLocation: "./app/agent/" } as ProjectRuntime).localCode,
    ).toBe("${{ workspace }}/app/agent");
  });

  test("keeps each path of a container image, which runs in /app under dev and on the Runtime", () => {
    const paths = runtimePaths(CONTAINER);

    expect(paths.runtimeCode).toBe(paths.localCode);
    expect(paths.runtimePython).toBe("${{ workspace }}/.venv/bin/python");
  });
});

describe("runtimeTemplate", () => {
  test("gives the profile create writes, and the [agent] of its Runtime form in the local paths", () => {
    const { local, runtime } = runtimeTemplate("demo", CODEZIP, "us-west-2");

    expect((local.agent as { command: string[] }).command).toContain("--reload");
    expect(Object.keys(runtime)).toEqual(["agent"]);
    const agent = runtime.agent as { command: string[]; env: Record<string, string> };
    expect(agent.command).not.toContain("--reload");
    expect(agent.command[0]).toBe("${{ workspace }}/app/agent/.venv/bin/python");
    expect(agent.env).not.toHaveProperty("LOCAL_DEV");
  });
});

describe("profileKeyPlaces", () => {
  test("places each table, each key, and each dotted key at its first line", () => {
    const text = [
      'packs = ["@box/base"]',
      'egress.github.destinations = ["api.github.com"]',
      "",
      "[mcp.notes]",
      'type = "stdio"',
      'command = ["x"]',
      "[mcp.notes.filesystem]",
      '  read = ["y"]',
    ].join("\n");

    const places = profileKeyPlaces(text, "p.toml");

    expect(places.get("packs")).toBe("p.toml:1:1");
    expect(places.get("egress.github")).toBe("p.toml:2:1");
    expect(places.get("egress.github.destinations")).toBe("p.toml:2:1");
    expect(places.get("mcp.notes")).toBe("p.toml:4:1");
    expect(places.get("mcp.notes.command")).toBe("p.toml:6:1");
    expect(places.get("mcp.notes.filesystem.read")).toBe("p.toml:8:3");
  });

  test("gives a rule the place of the key, of its nearest table, or the profile file", () => {
    const { placeOf } = context(
      CODEZIP,
      new Map([
        ["mcp.notes", "p.toml:3:1"],
        ["mcp.notes.command", "p.toml:5:1"],
      ]),
    );

    expect(placeOf(["mcp", "notes", "command"])).toBe("p.toml:5:1");
    expect(placeOf(["mcp", "notes", "env", "A"])).toBe("p.toml:3:1");
    expect(placeOf(["tool", "x"])).toBe(".box/agent/local/profile.toml");
  });
});

describe("keyLabel", () => {
  test("names a key as a message does", () => {
    expect(keyLabel(["packs"])).toBe("packs");
    expect(keyLabel(["mcp", "notes", "command"])).toBe("[mcp.notes] command");
  });
});

describe("serializeRuntimeProfile", () => {
  test("writes the profile as TOML after its header comments", () => {
    const profile = { packs: ["@box/base"], ...CARRIED, mcp: { notes: { type: "stdio" } } };

    const text = serializeRuntimeProfile(profile, ["Rendered by agentcore build."]);

    expect(text.startsWith("# Rendered by agentcore build.\n")).toBe(true);
    expect(parse(text)).toEqual(profile);
  });
});
