import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import {
  RUNTIME_TEMPLATE_SHORTCUTS,
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../../handlers/project/shortcuts";
import type { ScaffoldRuntimeInput } from "../../../../handlers/project/types";
import type { AgentCoreGatewayTarget } from "../../../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import { cloudWatchTelemetry, withDeployRegion, type CloudWatchTelemetry } from "../../boxNetwork";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAgentCorePack, renderBoxProfile } from "../../templates/boxProfile";
import { runtimeProfileContext } from "../context";
import { deriveRuntimeProfile } from "../derive";
import { serializeRuntimeProfile } from "../serialize";
import type { TomlTable } from "../types";
import { defaultMemoryName } from "../../../../projectSchemas/memory";
import {
  agentStartsUnderOtel,
  apply,
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_TRACES_TARGET,
  defaultTracesTelemetry,
  MEMORY_ROUTE,
  runtimeProfileHeader,
} from "./additions";

const PROFILE_FILE = ".box/agent/local/profile.toml";
/** The region create resolved, which the local profile names: not the build region. */
const CREATE_REGION = "us-east-1";
const BUILD_REGION = "us-west-2";

/**
 * The Runtime form of `recorded`, a profile the old renderer wrote for a runtime with its default
 * Memory: the Memory route goes to the AgentCore host directly, under the same name, in the same
 * place.
 */
function withDirectMemory(recorded: TomlTable): TomlTable {
  const result = structuredClone(recorded);
  if (isTableValue(result.egress)) result.egress[MEMORY_ROUTE] = DIRECT_MEMORY_ROUTE;
  return result;
}

const isTableValue = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The route of the agent's Memory calls: to Memory directly, signed with the execution role. */
const DIRECT_MEMORY_ROUTE = {
  destinations: [`bedrock-agentcore.${BUILD_REGION}.amazonaws.com`],
  secret: { ref: "aws://" },
};

type Build = "CodeZip" | "Container";
type Protocol = NonNullable<ProjectRuntime["protocol"]>;

/**
 * A box runtime, with OTEL off unless `otel`: only the OTEL tests depend on it. With OTEL on it has
 * no `instrumentation`, as `agentcore create` writes it.
 */
function runtimeOf(
  build: Build,
  protocol: Protocol = "HTTP",
  modelProvider = "Bedrock",
  otel = false,
) {
  return {
    name: "agent",
    build,
    entrypoint: build === "CodeZip" ? "start.py" : "main.py",
    codeLocation: "app/agent",
    protocol,
    modelProvider,
    ...(!otel && { instrumentation: { enableOtel: false } }),
    box: { version: "1.0.0" },
  } as ProjectRuntime;
}

function passthrough(name: string, endpoint: string): AgentCoreGatewayTarget {
  return {
    name,
    targetType: "passthrough",
    passthrough: { endpoint },
    outboundAuth: { type: "NONE" },
  } as AgentCoreGatewayTarget;
}

/**
 * A Box project with `runtime`, its Box gateway with the target build adds, and `memories`. Build
 * adds no target for Memory: the agent's Memory calls go to Memory directly.
 */
function specOf(runtime: ProjectRuntime, memories: readonly string[] = []) {
  const targets = [passthrough("bedrock", `https://bedrock-runtime.${BUILD_REGION}.amazonaws.com`)];
  return {
    name: "demo",
    runtimes: [runtime],
    memories: memories.map((name) => ({ name, eventExpiryDuration: 30, strategies: [] })),
    projectType: "box",
    agentCoreGateways: [{ ...boxGatewaySpec(runtime.name), targets }],
  } as unknown as ProjectSpec;
}

function contextOf(
  runtime: ProjectRuntime,
  options: {
    memories?: readonly string[];
    telemetry?: readonly CloudWatchTelemetry[];
  } = {},
) {
  const spec = specOf(runtime, options.memories);
  return runtimeProfileContext({
    spec,
    runtime,
    profileFile: PROFILE_FILE,
    region: BUILD_REGION,
    gateway: {
      name: spec.agentCoreGateways[0]!.name,
      targets: spec.agentCoreGateways[0]!.targets,
    },
    hosts: [],
    telemetry: options.telemetry ?? [],
    places: new Map(),
  });
}

/** The local profile that `agentcore create` writes for `runtime`, as a table. */
function createdProfile(runtime: ProjectRuntime): TomlTable {
  const input = {
    runtimeName: runtime.name,
    build: runtime.build,
    language: "Python",
    framework: "strands",
    protocol: runtime.protocol,
    modelProvider: runtime.modelProvider,
    boxTemplate: true,
  } as ScaffoldRuntimeInput;
  return parse(renderBoxProfile("demo", input, CREATE_REGION)!) as TomlTable;
}

/** The `[telemetry]` of a local profile: a CloudWatch target of each kind, signed under dev. */
const CLOUDWATCH: TomlTable = {
  logs: {
    kind: "cloudwatch_logs",
    region: "eu-west-1",
    log_group: "/aws/box",
    log_stream: "agent",
    include: ["logs", "trace"],
    secret: { ref: "aws://default" },
  },
  "x-ray": { kind: "cloudwatch_traces", secret: { ref: "aws://Admin-personal" } },
};

/**
 * The default target of the Runtime profile: the runtime's own log group and log stream, in its own
 * region, which box reads through the inputs of the @box/agentcore pack.
 */
const DEFAULT_TARGET = {
  kind: "cloudwatch_logs",
  region: "${{ inputs.aws.region }}",
  log_group: "${{ inputs.runtime.log_group }}",
  log_stream: "${{ inputs.runtime.log_stream }}",
  include: ["deny", "permit", "trace"],
  secret: { ref: "aws://" },
};

/** The default X-Ray target of a Runtime profile with OTEL on. */
const DEFAULT_TRACES = {
  kind: "cloudwatch_traces",
  region: "${{ inputs.aws.region }}",
  include: ["deny", "permit", "trace"],
  secret: { ref: "aws://" },
};

/** The words that start the agent under opentelemetry-instrument on the Runtime. */
const OTEL_START: Record<Build, string[]> = {
  CodeZip: ["${{ inputs.python.path }}", "${{ inputs.code.dir }}/bin/opentelemetry-instrument"],
  Container: ["${{ workspace }}/.venv/bin/opentelemetry-instrument"],
};

/**
 * `profile`, a Runtime profile with OTEL off, as OTEL on gives it: the agent starts under
 * opentelemetry-instrument, and the default X-Ray target comes last when no target is
 * `cloudwatch_traces`. Nothing else changes.
 */
function withOtel(profile: TomlTable, build: Build): TomlTable {
  const result = structuredClone(profile);
  const agent = result.agent as TomlTable;
  agent.command = [...OTEL_START[build], ...(agent.command as string[])];
  const telemetry = result.telemetry as Record<string, TomlTable>;
  if (!Object.values(telemetry).some(({ kind }) => kind === "cloudwatch_traces")) {
    telemetry.agentcore_traces = DEFAULT_TRACES;
  }
  return result;
}

/** The CloudWatch targets that box takes from the local profile `local`, as build gives them. */
const acceptedTelemetry = (local: TomlTable) =>
  withDeployRegion(cloudWatchTelemetry(local), BUILD_REGION, PROFILE_FILE).telemetry;

/** The [telemetry] of a local profile for each case: none, a target of each kind, traces only. */
const TELEMETRY_CASES: Record<string, TomlTable | undefined> = {
  none: undefined,
  "logs and traces": CLOUDWATCH,
  "traces only": { "x-ray": CLOUDWATCH["x-ray"] },
};

/**
 * What the Runtime renderer that the derivation replaced wrote: the owned tables for each build and
 * protocol (`templates`), the whole profile for each box template of create (`boxTemplates`), and
 * the gateway fixture. The gateway fixture is recorded from renderRuntimeBoxProfile of
 * box-integration (f5503f02). The two template sets are recorded, with the default telemetry
 * target, from the renderer of aws/agentcore-cli#2867 (f40ebce7): box-integration (7252504c) with
 * the `@box/` pack names and no ffi shim.
 */
const OLD_RENDERER = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "__fixtures__", "old-renderer-tables.json"), "utf8"),
) as {
  templates: Record<string, TomlTable>;
  boxTemplates: Record<string, TomlTable>;
  gateway: Record<string, TomlTable>;
};

/** The tables that the additions rule owns, which the old renderer wrote. */
const OWNED = [
  "packs",
  "policies",
  "profile",
  "project",
  "options",
  "agent",
  "tool",
  "telemetry",
] as const;

const agentOf = (profile: TomlTable) => profile.agent as Record<string, any>;

/** The `[telemetry]` of a derived profile. */
const tableOf = (profile: TomlTable) => profile.telemetry as TomlTable;

describe("deriveRuntimeProfile on the created templates", () => {
  const cases = (
    [
      ["CodeZip", "HTTP"],
      ["CodeZip", "MCP"],
      ["CodeZip", "A2A"],
      ["CodeZip", "AGUI"],
      ["Container", "HTTP"],
      ["Container", "MCP"],
    ] as const
  ).flatMap(([build, protocol]) =>
    ["Bedrock", "OpenAI"].flatMap((provider) =>
      [[], ["agentMemory"]].flatMap((memories) =>
        Object.keys(TELEMETRY_CASES).flatMap((telemetry) =>
          [false, true].map((otel) => ({ build, protocol, provider, memories, telemetry, otel })),
        ),
      ),
    ),
  );

  test.each(cases)(
    "gives the tables the old renderer wrote (recorded in __fixtures__), and the default target with no cloudwatch_logs target, and with OTEL on only the OTEL start and the default X-Ray target ($build $protocol $provider, memories $memories, telemetry $telemetry, OTEL $otel)",
    ({ build, protocol, provider, memories, telemetry: telemetryCase, otel }) => {
      const runtime = runtimeOf(build, protocol, provider, otel);
      const local = createdProfile(runtime);
      const tables = TELEMETRY_CASES[telemetryCase];
      const extras = tables !== undefined;
      if (extras) {
        local.policies = ["policy.dw"];
        local.telemetry = structuredClone(tables);
      }
      const telemetry = withDeployRegion(
        cloudWatchTelemetry(local),
        BUILD_REGION,
        PROFILE_FILE,
      ).telemetry;
      const { profile, problems } = deriveRuntimeProfile(
        local,
        contextOf(runtime, { memories, telemetry }),
      );

      const old = OLD_RENDERER.templates[
        `${build} ${protocol} ${provider} memories=${memories.length} telemetry=${telemetryCase}`
      ] as TomlTable;
      const recorded = memories.length > 0 ? withDirectMemory(old) : old;
      const expected = otel ? withOtel(recorded, build) : recorded;
      expect(problems).toEqual([]);
      for (const key of OWNED)
        expect([key, profile[key]]).toEqual([key, expected[key] ?? undefined]);
    },
  );
});

/** The name of each box template of `agentcore create`. */
const BOX_TEMPLATES = (Object.keys(RUNTIME_TEMPLATE_SHORTCUTS) as RuntimeTemplateShortcutName[])
  .filter((name) => (RUNTIME_TEMPLATE_SHORTCUTS[name] as { box?: boolean }).box === true)
  .sort();

/**
 * The runtime that `agentcore create` writes into agentcore.json for the template `input`, with
 * `instrumentation.enableOtel` false unless `otel`.
 */
function createdRuntime(input: ScaffoldRuntimeInput, otel: boolean): ProjectRuntime {
  return {
    name: input.runtimeName,
    build: input.build,
    entrypoint: input.build === "CodeZip" ? "start.py" : "main.py",
    codeLocation: `app/${input.runtimeName}`,
    ...(input.protocol !== undefined && { protocol: input.protocol }),
    ...(input.modelProvider !== undefined && { modelProvider: input.modelProvider }),
    ...(!otel && { instrumentation: { enableOtel: false } }),
    box: { version: "1.0.0" },
  } as ProjectRuntime;
}

describe("deriveRuntimeProfile on each box template of create", () => {
  const cases = BOX_TEMPLATES.flatMap((template) => {
    const providers = RUNTIME_TEMPLATE_SHORTCUTS[template].supportsModelProviderOverride
      ? ["of the template", "OpenAI"]
      : ["of the template"];
    return providers.flatMap((provider) =>
      [[], ["agentMemory"]].flatMap((memories) =>
        Object.keys(TELEMETRY_CASES).flatMap((telemetry) =>
          [false, true].map((otel) => ({ template, provider, memories, telemetry, otel })),
        ),
      ),
    );
  });

  test.each(cases)(
    "gives the whole profile that the old renderer wrote (recorded in __fixtures__), with the default target when no target is cloudwatch_logs, and with OTEL on only the OTEL start and the default X-Ray target ($template, provider $provider, memories $memories, telemetry $telemetry, OTEL $otel)",
    ({ template, provider, memories, telemetry: telemetryCase, otel }) => {
      const input = resolveRuntimeTemplateShortcut(
        template as RuntimeTemplateShortcutName,
        provider === "OpenAI" ? { modelProvider: "OpenAI", apiKey: "sk-test" } : {},
      );
      const runtime = createdRuntime(input, otel);
      const local = parse(renderBoxProfile("demo", input, CREATE_REGION)!) as TomlTable;
      const tables = TELEMETRY_CASES[telemetryCase];
      const extras = tables !== undefined;
      if (extras) {
        local.policies = ["policy.dw"];
        local.telemetry = structuredClone(tables);
      }
      const telemetry = withDeployRegion(
        cloudWatchTelemetry(local),
        BUILD_REGION,
        PROFILE_FILE,
      ).telemetry;

      const { profile, problems } = deriveRuntimeProfile(
        local,
        contextOf(runtime, {
          memories: memories.length > 0 ? [defaultMemoryName(runtime.name)] : [],
          telemetry,
        }),
      );

      // The old renderer sent the Memory calls through the gateway's `agentcore` target.
      const old =
        OLD_RENDERER.boxTemplates[
          `${template} provider=${provider} memories=${memories.length} telemetry=${telemetryCase}`
        ]!;
      const recorded = memories.length > 0 ? withDirectMemory(old) : old;
      expect(problems).toEqual([]);
      expect(profile).toEqual(otel ? withOtel(recorded, input.build as Build) : recorded);
    },
  );
});

describe("the additions rule", () => {
  const CODEZIP = runtimeOf("CodeZip");
  const CONTAINER = runtimeOf("Container");

  test("carries each key and table that it does not own, with keys that build does not know", () => {
    const local: TomlTable = {
      ...createdProfile(CODEZIP),
      "agent-args": ["--verbose"],
      "future-key": { anything: [1, 2] },
      tool: { notes: { program: "/usr/bin/notes" } },
      mcp: { files: { type: "stdio", command: ["/usr/bin/files"] } },
    };
    (local.agent as TomlTable).when = { "future-agent-key": true };

    const { table, problems } = apply(local, contextOf(CODEZIP));

    expect(problems).toEqual([]);
    expect(table["agent-args"]).toEqual(["--verbose"]);
    expect(table["future-key"]).toEqual({ anything: [1, 2] });
    expect(table.tool).toEqual(local.tool);
    expect(table.mcp).toEqual(local.mcp);
    expect(table.egress).toEqual(local.egress);
    expect(agentOf(table).when).toEqual({ "future-agent-key": true });
  });

  test("changes no table that it gets", () => {
    const local = { ...createdProfile(CODEZIP), telemetry: structuredClone(CLOUDWATCH) };
    const before = structuredClone(local);

    apply(local, contextOf(CODEZIP));

    expect(local).toEqual(before);
  });

  test("removes the [tool.uname] table that a CodeZip template writes, and keeps each tool table of the user", () => {
    const local = createdProfile(CODEZIP);
    const notes = { program: "/usr/bin/notes" };
    const changed = { filesystem: { deny_write: ["${{ workspace }}/app/agent/data"] } };

    expect(Object.keys(local.tool as TomlTable)).toEqual(["uname"]);
    expect(apply(local, contextOf(CODEZIP)).table).not.toHaveProperty("tool");
    expect(
      apply({ ...local, tool: { ...(local.tool as TomlTable), notes } }, contextOf(CODEZIP)).table
        .tool,
    ).toEqual({ notes });
    expect(apply({ ...local, tool: { uname: changed } }, contextOf(CODEZIP)).table.tool).toEqual({
      uname: changed,
    });
  });

  test("keeps the user's packs in their order, then adds the Runtime packs once", () => {
    const packs = ["box/gh", "@box/base", "@box/bedrock"];

    expect(apply({ packs }, contextOf(CODEZIP)).table.packs).toEqual([
      ...packs,
      "@box/agentcore",
      "@box/agentcore-codezip",
    ]);
    expect(apply({ packs }, contextOf(CONTAINER)).table.packs).toEqual([
      ...packs,
      "@box/agentcore",
    ]);
    expect(
      apply({ packs: ["@box/agentcore", "@box/base"] }, contextOf(CONTAINER)).table.packs,
    ).toEqual(["@box/agentcore", "@box/base"]);
    expect(apply({}, contextOf(CONTAINER)).table.packs).toEqual(["@box/agentcore"]);
  });

  test("adds no Runtime pack that the profile already lists, on CodeZip and on a container", () => {
    const codeZip = ["@box/agentcore-codezip", "@box/base", "@box/agentcore"];
    const container = ["@box/base", "@box/agentcore"];

    expect(apply({ packs: codeZip }, contextOf(CODEZIP)).table.packs).toEqual(codeZip);
    expect(apply({ packs: container }, contextOf(CONTAINER)).table.packs).toEqual(container);
  });

  test("names the profile for the project, and keeps the other [profile] keys", () => {
    const local = { profile: { name: "demo-agent", description: "mine" } };

    expect(apply(local, contextOf(CODEZIP)).table.profile).toEqual({
      name: "demo",
      description: "mine",
    });
  });

  test("sets bedrock.region to the build region, and keeps the other options", () => {
    const dotted = { options: { bedrock: { region: CREATE_REGION }, other: { input: "x" } } };
    const quoted = { options: { "bedrock.region": CREATE_REGION } };

    expect(apply(dotted, contextOf(CODEZIP)).table.options).toEqual({
      bedrock: { region: BUILD_REGION },
      other: { input: "x" },
    });
    expect(apply(quoted, contextOf(CODEZIP)).table.options).toEqual({
      "bedrock.region": BUILD_REGION,
    });
    expect(apply({ packs: ["@box/bedrock"] }, contextOf(CODEZIP)).table.options).toEqual({
      bedrock: { region: BUILD_REGION },
    });
    expect(apply({ packs: ["@box/base"] }, contextOf(CODEZIP)).table.options).toBeUndefined();
  });

  describe("[agent] command", () => {
    test("gives the template's own command its Runtime command, which the paths rule then moves", () => {
      const runtimeCommand = (app: string, python: string) => [
        python,
        "-m",
        "uvicorn",
        "main:app",
        "--app-dir",
        app,
        "--host",
        "127.0.0.1",
        "--port",
        "8081",
      ];
      const local = createdProfile(CODEZIP);

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).command).toEqual(
        runtimeCommand("${{ workspace }}", "${{ workspace }}/.venv/bin/python"),
      );
      expect(agentOf(deriveRuntimeProfile(local, contextOf(CODEZIP)).profile).command).toEqual(
        runtimeCommand("${{ inputs.code.dir }}", "${{ inputs.python.path }}"),
      );
    });

    test("removes --reload and --reload-dir from a command of the user, and moves no path", () => {
      const local = createdProfile(CODEZIP);
      agentOf(local).command = [
        "${{ workspace }}/.venv/bin/python",
        "-m",
        "uvicorn",
        "main:app",
        "--reload",
        "--reload-dir",
        "${{ workspace }}",
        "--reload-dir=${{ workspace }}/lib",
        "--log-level",
        "debug",
      ];

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).command).toEqual([
        "${{ workspace }}/.venv/bin/python",
        "-m",
        "uvicorn",
        "main:app",
        "--log-level",
        "debug",
      ]);
    });
  });

  describe("[agent.env]", () => {
    test("removes LOCAL_DEV, swaps the template's values, adds the Runtime's, and keeps the user's", () => {
      const local = createdProfile(CODEZIP);
      agentOf(local).env = {
        ...agentOf(local).env,
        LOCAL_DEV: "0",
        LOG_LEVEL: "debug",
        DATA: "${{ workspace }}/app/agent/data",
      };

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).env).toEqual({
        PORT: "8081",
        PYTHONPATH: "${{ inputs.code.dir }}",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        AWS_DEFAULT_REGION: "${{ inputs.aws.region }}",
        AWS_ACCESS_KEY_ID: "box-stand-in",
        AWS_SECRET_ACCESS_KEY: "box-stand-in",
        LOG_LEVEL: "debug",
        DATA: "${{ workspace }}/app/agent/data",
      });
    });

    test("keeps a template variable that the user changed, and leaves out one the user removed", () => {
      const local = createdProfile(CONTAINER);
      const { PYTHONUNBUFFERED: _removed, ...env } = agentOf(local).env;
      agentOf(local).env = { ...env, PORT: "9999" };

      const result = agentOf(apply(local, contextOf(CONTAINER)).table).env;

      expect(result.PORT).toBe("9999");
      expect(result).not.toHaveProperty("PYTHONUNBUFFERED");
      expect(result).not.toHaveProperty("PYTHONPATH");
    });

    test("gives the agent the region of the Runtime over a region of the user, and says so", () => {
      const local = { packs: ["@box/base"], agent: { env: { AWS_REGION: "eu-west-1" } } };
      const withBedrock = { ...local, packs: ["@box/base", "@box/bedrock"] };

      const own = apply(local, contextOf(CODEZIP));
      const bedrock = apply(withBedrock, contextOf(CODEZIP));

      expect(agentOf(own.table).env.AWS_REGION).toBe("${{ inputs.aws.region }}");
      expect(own.warnings).toEqual([
        `[agent.env] AWS_REGION is "eu-west-1" in ${PROFILE_FILE}. On AgentCore Runtime the ` +
          "agent gets the region of the Runtime, ${{ inputs.aws.region }}, so build does not use " +
          "this value.",
      ]);
      // @box/bedrock sets AWS_REGION itself, so the profile does not.
      expect(agentOf(bedrock.table).env).not.toHaveProperty("AWS_REGION");
      expect(bedrock.warnings).toEqual([
        `[agent.env] AWS_REGION is "eu-west-1" in ${PROFILE_FILE}. On AgentCore Runtime the ` +
          "agent gets the region of the Runtime from @box/bedrock, so build does not use this value.",
      ]);
    });

    test("sends no AWS_PROFILE to the Runtime, and says so", () => {
      const { table, warnings } = apply(
        { agent: { env: { AWS_PROFILE: "Admin" } } },
        contextOf(CODEZIP),
      );

      expect(agentOf(table).env).not.toHaveProperty("AWS_PROFILE");
      expect(warnings).toEqual([
        `[agent.env] AWS_PROFILE is "Admin" in ${PROFILE_FILE}. AgentCore Runtime has no AWS ` +
          "profiles: box signs each AWS call with the execution role. Build does not send " +
          "AWS_PROFILE to the Runtime.",
      ]);
    });

    test("sets AWS_REGION only when the profile imports no @box/bedrock", () => {
      const local = createdProfile(CODEZIP);

      const bedrock = agentOf(apply(local, contextOf(CODEZIP)).table).env;
      const other = agentOf(
        apply({ ...local, packs: ["@box/base"] }, contextOf(CODEZIP)).table,
      ).env;

      expect(bedrock).not.toHaveProperty("AWS_REGION");
      expect(other.AWS_REGION).toBe("${{ inputs.aws.region }}");
      expect(other.AWS_DEFAULT_REGION).toBe("${{ inputs.aws.region }}");
    });

    test("keeps a PYTHONPATH of the user as it is, on CodeZip and on a container", () => {
      const env = { PYTHONPATH: "${{ workspace }}/app/agent/lib" };

      for (const runtime of [CODEZIP, CONTAINER]) {
        expect(agentOf(apply({ agent: { env } }, contextOf(runtime)).table).env.PYTHONPATH).toBe(
          "${{ workspace }}/app/agent/lib",
        );
      }
    });

    test("gives an [agent] with no PYTHONPATH the code folder on CodeZip, and none on a container", () => {
      expect(agentOf(apply({ agent: {} }, contextOf(CODEZIP)).table).env.PYTHONPATH).toBe(
        "${{ inputs.code.dir }}",
      );
      expect(agentOf(apply({ agent: {} }, contextOf(CONTAINER)).table).env).not.toHaveProperty(
        "PYTHONPATH",
      );
    });

    test("sets the region, the AWS stand-ins, and the PYTHONPATH of the code folder whatever the template's Runtime env", () => {
      const openAi = runtimeOf("CodeZip", "HTTP", "OpenAI");
      const context = contextOf(openAi);
      const runtime = structuredClone(context.template.runtime);
      (runtime.agent as TomlTable).env = { PORT: "8081", PYTHONUTF8: "1" };
      const template = { ...context.template, runtime };

      const env = agentOf(apply(createdProfile(openAi), { ...context, template }).table).env;

      expect(env).toEqual({
        PORT: "8081",
        PYTHONUTF8: "1",
        AWS_REGION: "${{ inputs.aws.region }}",
        AWS_DEFAULT_REGION: "${{ inputs.aws.region }}",
        AWS_ACCESS_KEY_ID: "box-stand-in",
        AWS_SECRET_ACCESS_KEY: "box-stand-in",
        PYTHONPATH: "${{ inputs.code.dir }}",
      });
    });
  });

  describe("[agent.filesystem]", () => {
    test("gives the template's grants their Runtime grants, and keeps each grant of the user", () => {
      const local = createdProfile(CODEZIP);
      const filesystem = agentOf(local).filesystem;
      filesystem.read.push("${{ workspace }}/data", "/usr/lib64");
      filesystem.deny_write.push("${{ workspace }}/secrets");
      filesystem.write = ["/tmp/agent"];

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).filesystem).toEqual({
        read: [
          "${{ workspace }}",
          "${{ home }}/.local/share/uv/python",
          "/usr/lib64",
          "/lib64",
          "${{ workspace }}/data",
        ],
        exec: ["${{ workspace }}", "${{ home }}/.local/share/uv/python"],
        deny_write: ["${{ workspace }}/secrets"],
        write: ["/tmp/agent"],
      });
      // The paths rule moves each path of the project after this rule.
      expect(agentOf(deriveRuntimeProfile(local, contextOf(CODEZIP)).profile).filesystem).toEqual({
        read: [
          "${{ inputs.code.dir }}",
          "${{ inputs.python.prefix }}",
          "/usr/lib64",
          "/lib64",
          "${{ inputs.code.dir }}/data",
        ],
        exec: ["${{ inputs.code.dir }}", "${{ inputs.python.prefix }}"],
        deny_write: ["${{ inputs.code.dir }}/secrets"],
        write: ["/tmp/agent"],
      });
    });

    test("keeps the grants that only the Runtime has, and no grant of the template that the user removed", () => {
      const local = createdProfile(CODEZIP);
      const filesystem = agentOf(local).filesystem;
      // The user removes the read grant of the uv Pythons.
      filesystem.read = filesystem.read.filter(
        (grant: unknown) =>
          (grant as { path?: string }).path !== "${{ home }}/.local/share/uv/python",
      );

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).filesystem).toEqual({
        read: ["${{ workspace }}", "/usr/lib64", "/lib64"],
        exec: ["${{ workspace }}", "${{ home }}/.local/share/uv/python"],
      });
    });

    test("gives an [agent] with no filesystem table only the grants that only the Runtime has", () => {
      const local = createdProfile(CODEZIP);
      delete agentOf(local).filesystem;

      expect(agentOf(apply(local, contextOf(CODEZIP)).table).filesystem).toEqual({
        read: ["/usr/lib64", "/lib64"],
        exec: ["${{ workspace }}"],
      });
    });

    test("leaves out a grant that the user removed from a container's template", () => {
      const local = createdProfile(CONTAINER);
      const filesystem = agentOf(local).filesystem;
      filesystem.exec = filesystem.exec.filter((grant: unknown) => grant !== "/usr/local/bin");

      expect(agentOf(apply(local, contextOf(CONTAINER)).table).filesystem.exec).toEqual(
        filesystem.exec,
      );
    });
  });

  test("listens on the port of the protocol on the Runtime when the user changed the local port, and says so", () => {
    const local = createdProfile(CODEZIP);
    agentOf(local).ingress = [{ listen: "127.0.0.1:8090", workload_port: 8081 }];

    const { table, warnings } = apply(local, contextOf(CODEZIP));

    expect(agentOf(table).ingress).toEqual([{ listen: "0.0.0.0:8080", workload_port: 8081 }]);
    expect(warnings).toEqual([
      `[[agent.ingress]] listen is "127.0.0.1:8090" in ${PROFILE_FILE}. AgentCore Runtime sends ` +
        "the HTTP requests only to port 8080, so the Runtime profile listens on 0.0.0.0:8080.",
    ]);
  });

  test("forwards to the workload port of the template while the agent keeps its command, and else to the port of the user", () => {
    const template = createdProfile(CODEZIP);
    agentOf(template).ingress = [{ listen: "127.0.0.1:8080", workload_port: 9001 }];
    const own = structuredClone(template);
    agentOf(own).command = ["${{ workspace }}/.venv/bin/python", "serve.py", "--port", "9001"];

    const kept = apply(template, contextOf(CODEZIP));
    const moved = apply(own, contextOf(CODEZIP));

    expect(agentOf(kept.table).ingress).toEqual([{ listen: "0.0.0.0:8080", workload_port: 8081 }]);
    expect(kept.warnings).toEqual([
      `[[agent.ingress]] workload_port is 9001 in ${PROFILE_FILE}, but the agent keeps the ` +
        "command and the port of the template, so on AgentCore Runtime it listens on 8081. The " +
        "Runtime profile forwards there.",
    ]);
    expect(agentOf(moved.table).ingress).toEqual([{ listen: "0.0.0.0:8080", workload_port: 9001 }]);
    expect(moved.warnings).toEqual([]);
  });

  test("gives no workload_port warning when the local first ingress sets none and the agent keeps the template command", () => {
    const local = createdProfile(CODEZIP);
    agentOf(local).ingress = [{ listen: "127.0.0.1:8080" }];

    const { table, warnings } = apply(local, contextOf(CODEZIP));

    expect(agentOf(table).ingress).toEqual([{ listen: "0.0.0.0:8080", workload_port: 8081 }]);
    expect(warnings).toEqual([]);
  });

  test("gives the template's ingress its Runtime ingress, and puts each other on 0.0.0.0", () => {
    const local = createdProfile(CODEZIP);
    agentOf(local).ingress.push({ listen: "127.0.0.1:9100", workload_port: 9101 });

    expect(agentOf(apply(local, contextOf(CODEZIP)).table).ingress).toEqual([
      { listen: "0.0.0.0:8080", workload_port: 8081 },
      { listen: "0.0.0.0:9100", workload_port: 9101 },
    ]);
  });

  describe("[telemetry]", () => {
    test("signs each CloudWatch target with a bare aws://, and keeps its keys and its region", () => {
      const local = {
        telemetry: {
          logs: { ...(CLOUDWATCH.logs as TomlTable), batch: { max: 5 } },
          "x-ray": CLOUDWATCH["x-ray"],
        },
      };

      expect(
        apply(local, contextOf(CODEZIP, { telemetry: acceptedTelemetry(local) })).table.telemetry,
      ).toEqual({
        logs: {
          ...(CLOUDWATCH.logs as TomlTable),
          batch: { max: 5 },
          secret: { ref: "aws://" },
        },
        "x-ray": { kind: "cloudwatch_traces", region: BUILD_REGION, secret: { ref: "aws://" } },
      });
    });

    test("copies no CloudWatch target that box refuses, as it grants it nothing, and adds the default target", () => {
      const local = {
        telemetry: {
          logs: { ...(CLOUDWATCH.logs as TomlTable), log_stream: "a:b" },
          "x-ray": { ...(CLOUDWATCH["x-ray"] as TomlTable), include: [] },
        },
      };

      expect(acceptedTelemetry(local)).toEqual([]);
      expect(
        apply(local, contextOf(CODEZIP, { telemetry: acceptedTelemetry(local) })).table.telemetry,
      ).toEqual({ agentcore: DEFAULT_TARGET });
    });

    test("signs a table with no kind that adds to the CloudWatch target of a pack", () => {
      const local = { telemetry: { logs: { include: ["deny"] } } };
      const telemetry = [
        {
          name: "logs",
          kind: "cloudwatch_logs",
          region: "ap-south-1",
          logGroup: "/team/agent",
          logStream: "box",
        } as const,
      ];

      // The pack gives the kind, the log group, and the log stream on the Runtime too.
      expect(apply(local, contextOf(CODEZIP, { telemetry })).table.telemetry).toEqual({
        logs: { region: "ap-south-1", include: ["deny"], secret: { ref: "aws://" } },
      });
    });

    test("gives a target with no region the region of the box network model", () => {
      const local = { telemetry: { "x-ray": CLOUDWATCH["x-ray"] } };
      const telemetry = [
        { name: "x-ray", kind: "cloudwatch_traces", region: "ap-south-1" } as const,
      ];

      expect(apply(local, contextOf(CODEZIP, { telemetry })).table.telemetry).toEqual({
        "x-ray": { kind: "cloudwatch_traces", region: "ap-south-1", secret: { ref: "aws://" } },
        agentcore: DEFAULT_TARGET,
      });
    });

    test("leaves a target of another kind as it is, and leaves out a file target with a warning", () => {
      const langfuse = { kind: "langfuse", secret: { ref: "env://LANGFUSE_AUTH" } };
      const local = {
        telemetry: { records: { kind: "file", destination: "/tmp/records.jsonl" }, langfuse },
      };

      const { table, warnings } = apply(local, contextOf(CODEZIP));

      expect(table.telemetry).toEqual({ langfuse, agentcore: DEFAULT_TARGET });
      expect(warnings).toEqual([
        "[telemetry.records] writes its records to a file. On AgentCore Runtime that file is in " +
          "the microVM, where nothing reads it, so build leaves the target out of the Runtime " +
          "profile.",
      ]);
    });

    test("adds each CloudWatch target of the context that the local profile does not declare", () => {
      const telemetry: CloudWatchTelemetry[] = [
        {
          name: "pack-logs",
          kind: "cloudwatch_logs",
          region: "eu-west-1",
          logGroup: "/aws/pack",
          logStream: "s",
          include: ["logs"],
        },
      ];

      expect(apply({}, contextOf(CODEZIP, { telemetry })).table.telemetry).toEqual({
        "pack-logs": {
          kind: "cloudwatch_logs",
          region: "eu-west-1",
          log_group: "/aws/pack",
          log_stream: "s",
          include: ["logs"],
          secret: { ref: "aws://" },
        },
      });
    });
  });

  describe("the default CloudWatch Logs target", () => {
    test("sends to the runtime's own log group and stream, read when the run starts, when the profile has no [telemetry]", () => {
      const { table } = apply(createdProfile(CODEZIP), contextOf(CODEZIP));

      expect(table.telemetry).toEqual({ agentcore: DEFAULT_TARGET });
      // The target names no literal region, not even the build region, and no log group of build.
      const text = JSON.stringify(table.telemetry);
      expect(text).not.toContain(BUILD_REGION);
      expect(text).not.toContain("/aws/bedrock-agentcore/");
      expect({ ...DEFAULT_TELEMETRY_TARGET } as TomlTable).toEqual(DEFAULT_TARGET);
    });

    test("reads each value through an input that the @box/agentcore pack declares", () => {
      const { inputs } = parse(renderAgentCorePack(specOf(CODEZIP), CODEZIP)) as {
        inputs: Record<string, Record<string, unknown>>;
      };
      const declared = (placeholder: string) => {
        const [group, name] = /^\$\{\{ inputs\.([a-z]+)\.([a-z_]+) \}\}$/
          .exec(placeholder)!
          .slice(1);
        return inputs[group!]?.[name!];
      };

      expect(declared(DEFAULT_TARGET.region)).toMatchObject({ from: "env:AWS_REGION" });
      expect(declared(DEFAULT_TARGET.log_group)).toMatchObject({
        from: "env:OTEL_EXPORTER_OTLP_LOGS_HEADERS",
        key: "x-aws-log-group",
      });
      expect(declared(DEFAULT_TARGET.log_stream)).toMatchObject({
        from: "env:OTEL_EXPORTER_OTLP_LOGS_HEADERS",
        key: "x-aws-log-stream",
      });
    });

    test("adds no default target when the profile has its own cloudwatch_logs target", () => {
      const local = { telemetry: { logs: CLOUDWATCH.logs } };

      expect(
        apply(local, contextOf(CONTAINER, { telemetry: acceptedTelemetry(local) })).table.telemetry,
      ).toEqual({
        logs: { ...(CLOUDWATCH.logs as TomlTable), secret: { ref: "aws://" } },
      });
    });

    test("adds no default target when box resolves a cloudwatch_logs target that the profile does not declare", () => {
      const telemetry: CloudWatchTelemetry[] = [
        {
          name: "pack-logs",
          kind: "cloudwatch_logs",
          region: "eu-west-1",
          logGroup: "g",
          logStream: "s",
        },
      ];

      expect(Object.keys(tableOf(apply({}, contextOf(CODEZIP, { telemetry })).table))).toEqual([
        "pack-logs",
      ]);
    });

    test.each([
      ["true", false],
      [" TRUE ", false],
      ["false", true],
    ])(
      "adds the default target only when the envVars do not set DISABLE_ADOT_OBSERVABILITY to true (%j)",
      (value, added) => {
        const runtime = {
          ...CODEZIP,
          envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value }],
        } as ProjectRuntime;

        expect(Object.hasOwn(tableOf(apply({}, contextOf(runtime)).table), "agentcore")).toBe(
          added,
        );
      },
    );

    test("adds the default target beside a cloudwatch_traces target, as it sends no logs", () => {
      const local = { telemetry: { "x-ray": CLOUDWATCH["x-ray"] } };

      expect(
        apply(local, contextOf(CODEZIP, { telemetry: acceptedTelemetry(local) })).table.telemetry,
      ).toEqual({
        "x-ray": { kind: "cloudwatch_traces", region: BUILD_REGION, secret: { ref: "aws://" } },
        agentcore: DEFAULT_TARGET,
      });
    });

    test.each([
      ["a CloudWatch target", CLOUDWATCH["x-ray"]],
      ["a third-party target", { kind: "langfuse", secret: { ref: "env://LANGFUSE_AUTH" } }],
    ])("names the default target agentcore_default when %s is agentcore", (_label, target) => {
      const local = { telemetry: { agentcore: target } };
      const telemetry = tableOf(
        apply(local, contextOf(CODEZIP, { telemetry: acceptedTelemetry(local) })).table,
      );

      expect(Object.keys(telemetry)).toEqual(["agentcore", "agentcore_default"]);
      expect(telemetry.agentcore_default).toEqual(DEFAULT_TARGET);
      expect((telemetry.agentcore as TomlTable).kind).toBe((target as TomlTable).kind);
    });

    test("names the default target in the header, and no other target", () => {
      const context = contextOf(CODEZIP);
      const withDefault = apply({}, context).table;
      const own = { telemetry: { logs: CLOUDWATCH.logs } };
      const withOwn = apply(own, contextOf(CODEZIP, { telemetry: acceptedTelemetry(own) })).table;

      expect(runtimeProfileHeader(context, withDefault).at(-1)).toBe(
        "[telemetry.agentcore] is the default CloudWatch Logs target: the runtime's own log " +
          "group and log stream, which box reads from OTEL_EXPORTER_OTLP_LOGS_HEADERS when the " +
          `run starts. Add a cloudwatch_logs target to ${PROFILE_FILE} to use another.`,
      );
      expect(runtimeProfileHeader(context, withOwn)).toHaveLength(3);
    });
  });

  describe("the Memory route", () => {
    const MEMORY = defaultMemoryName("agent");

    test("sends the Memory calls of a runtime with its default Memory to Memory directly, signed with the execution role", () => {
      const { table, problems } = apply(
        createdProfile(CODEZIP),
        contextOf(CODEZIP, { memories: [MEMORY] }),
      );

      expect(problems).toEqual([]);
      const route = (table.egress as TomlTable)[MEMORY_ROUTE];
      expect(route).toEqual(DIRECT_MEMORY_ROUTE);
      // No backend: the Box gateway would sign the calls with its own role.
      expect(route).not.toHaveProperty("backends");
    });

    test("keeps each route of the profile, and adds the Memory route after them", () => {
      const local = {
        ...createdProfile(CONTAINER),
        egress: { github: { destinations: ["api.github.com"] } },
      };

      const egress = apply(local, contextOf(CONTAINER, { memories: [MEMORY] })).table
        .egress as TomlTable;

      expect(Object.keys(egress)).toEqual(["github", MEMORY_ROUTE]);
      expect(egress.github).toEqual({ destinations: ["api.github.com"] });
    });

    test("adds no Memory route for a runtime with no default Memory", () => {
      const none = apply(createdProfile(CODEZIP), contextOf(CODEZIP)).table;
      const other = apply(createdProfile(CODEZIP), contextOf(CODEZIP, { memories: ["shared"] }));
      expect(none.egress).not.toHaveProperty(MEMORY_ROUTE);
      expect(other.table.egress).not.toHaveProperty(MEMORY_ROUTE);
    });

    test("sends a route or HTTP MCP server of the profile to the AgentCore host directly, with its name, and adds no second route", () => {
      const host = `bedrock-agentcore.${BUILD_REGION}.amazonaws.com`;
      const backends = [{ url: "${{ inputs.gateway.url }}/egress-tools" }];
      const local = {
        egress: { tools: { destinations: [host], backends, when: "true" } },
        mcp: { recall: { type: "http", destinations: [host], backends } },
      };

      const { table, problems, warnings } = apply(
        local,
        contextOf(CODEZIP, { memories: [MEMORY] }),
      );

      // Box chooses where a connection goes from its host alone, so every call to the AgentCore
      // host goes there directly. Box refuses two signed routes for one host.
      expect([problems, warnings]).toEqual([[], []]);
      expect(table.egress).toEqual({
        tools: { destinations: [host], when: "true", secret: { ref: "aws://" } },
      });
      expect(table.mcp).toEqual({
        recall: { type: "http", destinations: [host], secret: { ref: "aws://" } },
      });
    });

    test("counts a route to the AgentCore host with :443, in another case, or as a wildcard", () => {
      const context = contextOf(CODEZIP, { memories: [MEMORY] });
      for (const destination of [
        `bedrock-agentcore.${BUILD_REGION}.amazonaws.com:443`,
        `Bedrock-AgentCore.${BUILD_REGION}.amazonaws.com`,
        "*.amazonaws.com",
      ]) {
        const local = { egress: { tools: { destinations: [destination] } } };

        expect([destination, apply(local, context).table.egress]).toEqual([
          destination,
          { tools: { destinations: [destination], secret: { ref: "aws://" } } },
        ]);
      }
      // Another port, or a wildcard of another domain, is not the AgentCore host.
      const other = {
        egress: {
          tools: {
            destinations: ["*.example.com", `bedrock-agentcore.${BUILD_REGION}.amazonaws.com:8443`],
          },
        },
      };
      expect(Object.keys(apply(other, context).table.egress as TomlTable)).toEqual([
        "tools",
        MEMORY_ROUTE,
      ]);
    });

    test("leaves a gateway route to the Memory host alone for a runtime with no default Memory", () => {
      const host = `bedrock-agentcore.${BUILD_REGION}.amazonaws.com`;
      const local = { egress: { memory: { destinations: [host], backends: [{ url: "x" }] } } };

      const { table, problems, warnings } = apply(local, contextOf(CODEZIP));
      expect([problems, warnings]).toEqual([[], []]);
      expect(table.egress).toEqual(local.egress);
    });

    test("names the gateway target when a target of the user takes the Memory route's name", () => {
      const context = contextOf(CODEZIP, { memories: [MEMORY] });
      const withTarget = {
        ...context,
        gateway: {
          ...context.gateway,
          targets: [
            ...context.gateway.targets,
            passthrough("agentcore", "https://memory.example.com"),
          ],
        },
      };
      const local = { egress: { [MEMORY_ROUTE]: { destinations: ["memory.example.com"] } } };

      const [problem] = apply(local, withTarget).problems;

      expect(problem?.place).toBe("agentcore/agentcore.json");
      expect(problem?.reason).toEndWith(
        `Rename the 'agentcore' target of gateway '${context.gateway.name}'.`,
      );
    });

    test("stops build for a route of the user under the name of the Memory route", () => {
      const local = { egress: { [MEMORY_ROUTE]: { destinations: ["api.example.com"] } } };

      const { problems } = apply(local, contextOf(CODEZIP, { memories: [MEMORY] }));

      expect(problems).toEqual([
        {
          code: "RUNTIME_ROUTE_NAME_TAKEN",
          key: ["egress", MEMORY_ROUTE],
          place: PROFILE_FILE,
          reason:
            `[egress.${MEMORY_ROUTE}] is the name of the route that the agent's Memory calls ` +
            `take on AgentCore Runtime, to bedrock-agentcore.${BUILD_REGION}.amazonaws.com. ` +
            "Rename that entry.",
        },
      ]);
    });
  });

  describe("with OTEL on", () => {
    const OTEL_CODEZIP = runtimeOf("CodeZip", "HTTP", "Bedrock", true);
    const OTEL_CONTAINER = runtimeOf("Container", "HTTP", "Bedrock", true);
    const otelRuntime = (build: Build) => (build === "CodeZip" ? OTEL_CODEZIP : OTEL_CONTAINER);
    const BUILDS: Build[] = ["CodeZip", "Container"];

    test.each(BUILDS)(
      "starts the template's own command under opentelemetry-instrument, and with OTEL off does not (%s)",
      (build) => {
        const local = createdProfile(otelRuntime(build));
        const off = agentOf(deriveRuntimeProfile(local, contextOf(runtimeOf(build))).profile);
        const on = agentOf(deriveRuntimeProfile(local, contextOf(otelRuntime(build))).profile);

        expect(on.command).toEqual([...OTEL_START[build], ...off.command]);
        expect(off.command.join(" ")).not.toContain("opentelemetry-instrument");
      },
    );

    test.each(["MCP", "A2A", "AGUI"] as const)(
      "starts a CodeZip %s template with the Runtime's Python and the script of the zip",
      (protocol) => {
        const runtime = runtimeOf("CodeZip", protocol, "Bedrock", true);

        expect(
          agentOf(deriveRuntimeProfile(createdProfile(runtime), contextOf(runtime)).profile)
            .command,
        ).toEqual([...OTEL_START.CodeZip, "${{ inputs.python.path }}", "-m", "main"]);
      },
    );

    test.each(BUILDS)(
      "starts a command of the user that runs the venv's Python under opentelemetry-instrument (%s)",
      (build) => {
        const command = ["${{workspace}}/.venv/bin/python3.12", "-m", "main", "--debug"];

        expect(
          agentOf(apply({ agent: { command } }, contextOf(otelRuntime(build))).table).command,
        ).toEqual([...OTEL_START[build], ...command]);
      },
    );

    test.each(BUILDS)(
      "does not start a command under opentelemetry-instrument twice (%s)",
      (build) => {
        const python = "${{ workspace }}/.venv/bin/python";
        const script = "${{ workspace }}/.venv/bin/opentelemetry-instrument";
        // The script as the program, and as the script that the venv's Python runs.
        for (const own of [
          [script, python, "-m", "main"],
          [python, script, python, "-m", "main"],
        ]) {
          expect(
            agentOf(apply({ agent: { command: own } }, contextOf(otelRuntime(build))).table)
              .command,
          ).toEqual(own);
        }
      },
    );

    test("leaves a command of another program as it is, and an [agent] with no command", () => {
      const command = ["/usr/local/bin/node", "${{ workspace }}/server.js"];

      expect(
        agentOf(apply({ agent: { command } }, contextOf(OTEL_CONTAINER)).table).command,
      ).toEqual(command);
      expect(agentOf(apply({ agent: {} }, contextOf(OTEL_CONTAINER)).table)).not.toHaveProperty(
        "command",
      );
    });

    test("tells whether the agent of a Runtime profile starts under opentelemetry-instrument", () => {
      const started = (command: unknown) => agentStartsUnderOtel({ agent: { command } });

      expect(started([...OTEL_START.Container, "${{ workspace }}/.venv/bin/python"])).toBe(true);
      expect(started([...OTEL_START.CodeZip, "${{ inputs.python.path }}"])).toBe(true);
      expect(started(["${{ workspace }}/.venv/bin/python", "-m", "main"])).toBe(false);
      expect(started(undefined)).toBe(false);
      expect(agentStartsUnderOtel({})).toBe(false);
    });

    test.each(BUILDS)(
      "adds the default X-Ray target when no target is cloudwatch_traces, and with OTEL off does not (%s)",
      (build) => {
        expect(tableOf(apply({}, contextOf(otelRuntime(build))).table)).toEqual({
          agentcore: DEFAULT_TARGET,
          agentcore_traces: DEFAULT_TRACES,
        });
        expect(tableOf(apply({}, contextOf(runtimeOf(build))).table)).toEqual({
          agentcore: DEFAULT_TARGET,
        });
        expect({ ...DEFAULT_TRACES_TARGET } as TomlTable).toEqual(DEFAULT_TRACES);
      },
    );

    test("adds the default X-Ray target beside a cloudwatch_logs target of the user", () => {
      const local = { telemetry: { logs: CLOUDWATCH.logs } };

      expect(
        Object.keys(
          tableOf(
            apply(local, contextOf(OTEL_CODEZIP, { telemetry: acceptedTelemetry(local) })).table,
          ),
        ),
      ).toEqual(["logs", "agentcore_traces"]);
    });

    test("adds no default X-Ray target when the profile has its own cloudwatch_traces target", () => {
      const local = { telemetry: { "x-ray": CLOUDWATCH["x-ray"] } };

      expect(
        tableOf(
          apply(local, contextOf(OTEL_CODEZIP, { telemetry: acceptedTelemetry(local) })).table,
        ),
      ).toEqual({
        "x-ray": { kind: "cloudwatch_traces", region: BUILD_REGION, secret: { ref: "aws://" } },
        agentcore: DEFAULT_TARGET,
      });
    });

    test("adds no default X-Ray target when box resolves a cloudwatch_traces target that the profile does not declare", () => {
      const telemetry: CloudWatchTelemetry[] = [
        { name: "pack-traces", kind: "cloudwatch_traces", region: "eu-west-1" },
      ];

      expect(Object.keys(tableOf(apply({}, contextOf(OTEL_CODEZIP, { telemetry })).table))).toEqual(
        ["pack-traces", "agentcore"],
      );
    });

    test.each([
      ["true", false],
      [" TRUE ", false],
      ["false", true],
    ])(
      "adds the default X-Ray target only when the envVars do not set DISABLE_ADOT_OBSERVABILITY to true (%j)",
      (value, added) => {
        const runtime = {
          ...OTEL_CODEZIP,
          envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value }],
        } as ProjectRuntime;
        const { table } = apply({}, contextOf(runtime));

        expect(Object.hasOwn(tableOf(table), "agentcore_traces")).toBe(added);
        expect(defaultTracesTelemetry(table, BUILD_REGION)).toHaveLength(added ? 1 : 0);
      },
    );

    test.each(BUILDS)(
      "does not start the agent under opentelemetry-instrument when the envVars set DISABLE_ADOT_OBSERVABILITY to true (%s)",
      (build) => {
        const optedOut = {
          ...otelRuntime(build),
          envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }],
        } as ProjectRuntime;
        const local = createdProfile(optedOut);

        expect(agentOf(deriveRuntimeProfile(local, contextOf(optedOut)).profile)).toEqual(
          agentOf(deriveRuntimeProfile(local, contextOf(runtimeOf(build))).profile),
        );
      },
    );

    test("names the default X-Ray target agentcore_traces_default when a target is agentcore_traces", () => {
      const local = { telemetry: { agentcore_traces: CLOUDWATCH.logs } };
      const telemetry = tableOf(
        apply(local, contextOf(OTEL_CODEZIP, { telemetry: acceptedTelemetry(local) })).table,
      );

      expect(Object.keys(telemetry)).toEqual(["agentcore_traces", "agentcore_traces_default"]);
      expect(telemetry.agentcore_traces_default).toEqual(DEFAULT_TRACES);
    });

    test("reads the region of the default X-Ray target through the input of @box/agentcore", () => {
      const { inputs } = parse(renderAgentCorePack(specOf(OTEL_CODEZIP), OTEL_CODEZIP)) as {
        inputs: { aws: { region: unknown } };
      };

      expect(DEFAULT_TRACES.region).toBe("${{ inputs.aws.region }}");
      expect(inputs.aws.region).toMatchObject({ from: "env:AWS_REGION" });
    });

    test("names the default X-Ray target in the header", () => {
      const context = contextOf(OTEL_CODEZIP);

      expect(runtimeProfileHeader(context, apply({}, context).table).at(-1)).toBe(
        "[telemetry.agentcore_traces] is the default X-Ray target: the agent's spans and box's " +
          `own, in the Runtime's region. Add a cloudwatch_traces target to ${PROFILE_FILE} to ` +
          "use another, or set instrumentation.enableOtel to false in agentcore.json to send none.",
      );
    });

    test("gives the default X-Ray target to the grant of the execution role, and no other target", () => {
      const { table } = apply({ telemetry: { logs: CLOUDWATCH.logs } }, contextOf(OTEL_CODEZIP));

      expect(defaultTracesTelemetry(table, BUILD_REGION)).toEqual([
        {
          name: "agentcore_traces",
          kind: "cloudwatch_traces",
          region: BUILD_REGION,
          include: ["deny", "permit", "trace"],
        },
      ]);
      expect(defaultTracesTelemetry(apply({}, contextOf(CODEZIP)).table, BUILD_REGION)).toEqual([]);
    });

    test.each(BUILDS)(
      "keeps each OTEL variable that the user sets in [agent.env], so it wins over the pack (%s)",
      (build) => {
        const env = { OTEL_TRACES_EXPORTER: "none", OTEL_RESOURCE_ATTRIBUTES: "service.name=mine" };

        expect(
          agentOf(apply({ agent: { env } }, contextOf(otelRuntime(build))).table).env,
        ).toMatchObject(env);
      },
    );
  });

  test("keeps the policies list as the local profile names it", () => {
    const local = { policies: ["./policy.dw", "rules/extra.dw"] };

    expect(apply(local, contextOf(CODEZIP)).table.policies).toEqual([
      "./policy.dw",
      "rules/extra.dw",
    ]);
  });

  test("writes a header that names the local profile and the Runtime packs", () => {
    const [, derived, standIns] = runtimeProfileHeader(contextOf(CODEZIP));

    expect(derived).toContain(`from ${PROFILE_FILE}, for AgentCore Runtime`);
    expect(derived).toContain("@box/agentcore and @box/agentcore-codezip packs");
    expect(runtimeProfileHeader(contextOf(CONTAINER))[1]).not.toContain("@box/agentcore-codezip");
    expect(standIns).toContain("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are stand-ins");
    expect(standIns).toEndWith("Every AWS route goes to the Box gateway.");
    const context = contextOf(CODEZIP, { memories: [defaultMemoryName("agent")] });
    const withMemory = runtimeProfileHeader(context, apply(createdProfile(CODEZIP), context).table);
    expect(withMemory[2]).toEndWith(
      `except each route to bedrock-agentcore.${BUILD_REGION}.amazonaws.com, such as ` +
        `[egress.${MEMORY_ROUTE}]: box sends the calls to that host directly, so Memory can hold ` +
        "each call to the session of the runtime.",
    );
    const text = serializeRuntimeProfile(
      apply(createdProfile(CODEZIP), contextOf(CODEZIP)).table,
      runtimeProfileHeader(contextOf(CODEZIP)),
    );
    expect(text.startsWith("# Runs the agent of the AgentCore project 'demo' in a box.\n")).toBe(
      true,
    );
  });
});
