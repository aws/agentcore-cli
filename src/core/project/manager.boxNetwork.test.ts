import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { InputValidationError, InvalidEnvironmentError } from "../../errors/errors";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { Project } from "../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, matchGolden, TestIdentityClient } from "../../testing";
import type { DeployBackendInput, ProjectBackend } from "./backends/types";
import { seedBoxCache } from "./backends/box-release-test-support";
import type { ResolvedBoxProfile } from "./boxProfileResolver";
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";
import { FsProjectManager } from "./manager";
import { renderRuntimeBoxProfile } from "./templates/boxProfile";

/** The golden files of this suite; `RECORD=1 bun test <this file>` rewrites them, with no AWS call. */
const FIXTURES = join(import.meta.dir, "__fixtures__");
const GATEWAY = "agent-python-strands-box";
const SPEC = "agentcore/agentcore.json";
const RUNTIME_PROFILE = "app/agent_python_strands/.box-dist/profile.toml";
const HR = 'action == Box::Action::"http:request"';
const NC = 'action == Box::Action::"net:connect"';
const POLICY =
  "// httpbin.org has no [egress] entry; the policy alone opens one path of it.\n" +
  `@id("httpbin_connect") permit (principal, ${NC}, resource) when { context.input.host == "httpbin.org" };\n` +
  `@id("httpbin_get") permit (principal, ${HR}, resource) when { context.input.host == "httpbin.org" && context.input.path == "/get" };\n`;
const GITHUB_ROUTE =
  '\n[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
/** Box's resolution of the Bedrock route of the profile `create` writes, with box/bedrock. */
const BEDROCK = {
  destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
  secret: { ref: "aws://default" },
};
const GITHUB = { destinations: ["api.github.com"], secret: { ref: "env://GITHUB_TOKEN" } };
/** What box resolves the created profile to, with `routes` beside its Bedrock route. */
const shows = (routes: Record<string, unknown> = {}, policy?: string) =>
  boxShowOf({ egress: { bedrock: BEDROCK, ...routes }, policy });
/**
 * A fake box that resolves box/bedrock for the Bedrock region of the profile it reads, as box does:
 * its answer's Bedrock host moves from us-west-2 to that region. Records the text of each profile.
 */
class RegionalBoxProfileResolver extends FakeBoxProfileResolver {
  public readonly profiles: string[] = [];

  public override async resolve(
    projectRoot: string,
    profilePath: string,
  ): Promise<ResolvedBoxProfile> {
    const answer = await super.resolve(projectRoot, profilePath);
    const text = await readFile(
      isAbsolute(profilePath) ? profilePath : join(projectRoot, profilePath),
      "utf8",
    );
    this.profiles.push(text);
    let region = "us-west-2";
    try {
      const { options } = parse(text) as { options?: { bedrock?: { region?: string } } };
      region = options?.bedrock?.region ?? region;
    } catch {
      // Box refuses a profile that is not TOML; build reports that failure itself.
    }
    const host = (name: string) => `bedrock-runtime.${name}.amazonaws.com`;
    const moved = (text: string) => text.replaceAll(host("us-west-2"), host(region));
    return {
      ...answer,
      boxToml: JSON.parse(moved(JSON.stringify(answer.boxToml))) as Record<string, unknown>,
      policy: moved(answer.policy),
    };
  }
}
const GITHUB_KEY = {
  type: "API_KEY",
  credentialName: "github",
  location: "HEADER",
  parameterName: "Authorization",
  prefix: "Bearer",
};
const GATEWAY_BACKEND = (target: string) => [
  {
    url: `\${{ inputs.gateway.url }}/${target}`,
    auth: {
      ref: "aws://",
      aws: { service: "bedrock-agentcore", region: "${{ inputs.aws.region }}" },
    },
  },
];

const originalCwd = process.cwd();
const directories: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A home folder whose box cache holds the pinned release, with stand-in binaries. */
async function boxHome(): Promise<string> {
  const home = await temporary("agentcore-box-home-");
  await seedBoxCache(home);
  return home;
}

async function drain<T>(generator: AsyncGenerator<{ type: string; message?: string }, T>) {
  const steps: string[] = [];
  const warnings: string[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { steps, warnings, value: next.value };
    if (next.value.type === "step") steps.push(next.value.message!);
    if (next.value.type === "warning") warnings.push(next.value.message!);
  }
}

/** A JSON reader and writer that counts its writes of agentcore.json. */
function countingJson() {
  const real = new FsReadWriteJson({ logger: createSilentLogger() });
  const counter = { specWrites: 0 };
  const json: ReadWriteJson = {
    read: (path, schema) => real.read(path, schema),
    write: (path, data) => {
      if (path.endsWith("agentcore.json")) counter.specWrites++;
      return real.write(path, data);
    },
  };
  return { json, counter };
}

/** A new Strands project, with the Box gateway entry and the box profile `create` writes. */
async function strandsProject(
  options: {
    backends?: { CDK: ProjectBackend };
    env?: NodeJS.ProcessEnv;
    template?: "agent-python-strands-box" | "agent-python-strands-box-container";
  } = {},
) {
  const directory = await temporary("agentcore-box-network-");
  process.chdir(directory);
  const { json, counter } = countingJson();
  const box = new RegionalBoxProfileResolver(shows());
  const manager = new FsProjectManager({
    logger: createSilentLogger(),
    identity: new TestIdentityClient(),
    enableTransactionSearch: async () => {},
    runner: async () => {},
    checkTool: async () => {},
    json,
    processEnv: {
      HOME: await boxHome(),
      AWS_REGION: "us-west-2",
      ...options.env,
    },
    boxProfileResolver: box,
    ...(options.backends && { backends: options.backends }),
  });
  const { value: created } = await drain(
    manager.create({
      name: "demo",
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(
        options.template ?? "agent-python-strands-box",
        { runtimeName: "agent_python_strands" },
      ),
      skipInstall: true,
      skipGit: true,
    }),
  );
  const root = created.rootPath;
  await mkdir(join(root, "agentcore", "cdk", "node_modules"), { recursive: true });
  counter.specWrites = 0;
  return { manager, root, counter, box };
}

const path = (root: string, relative: string) => join(root, ...relative.split("/"));
const text = (root: string, relative: string) => readFile(path(root, relative), "utf8");

/** Adds `tables` to the end of the profile, `top` to its start, and writes `.box/agent_python_strands/local/policy.dw`. */
async function editProfile(root: string, edit: { top?: string; tables?: string; policy?: string }) {
  const profile = await text(root, ".box/agent_python_strands/local/profile.toml");
  await writeFile(
    path(root, ".box/agent_python_strands/local/profile.toml"),
    `${edit.top ?? ""}${profile}${edit.tables ?? ""}`,
  );
  if (edit.policy !== undefined)
    await writeFile(path(root, ".box/agent_python_strands/local/policy.dw"), edit.policy);
}

/** Changes the Box gateway entry of agentcore.json, as a user does by hand. */
async function editGateway(root: string, edit: (gateway: { targets: unknown[] }) => void) {
  const spec = JSON.parse(await text(root, SPEC));
  edit(spec.agentCoreGateways.find(({ name }: { name: string }) => name === GATEWAY));
  await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
}

async function build(manager: FsProjectManager, root: string) {
  const project = (await manager.resolve({ filePath: root })) as Project;
  return drain(manager.build(project));
}

async function boxGateway(root: string) {
  const spec = JSON.parse(await text(root, SPEC));
  return spec.agentCoreGateways.find(({ name }: { name: string }) => name === GATEWAY) as {
    targets: Record<string, unknown>[];
  };
}

async function targetNames(root: string): Promise<string[]> {
  return (await boxGateway(root)).targets.map(({ name }) => name as string);
}

/** The rendered AgentCore Runtime box profile. */
async function runtimeProfile(root: string): Promise<Record<string, unknown>> {
  return parse(await text(root, RUNTIME_PROFILE)) as Record<string, unknown>;
}

/** The text of every file under `.box/agent_python_strands/local/`, by path. */
async function boxFiles(root: string): Promise<Record<string, string>> {
  const names = (await readdir(path(root, ".box/agent_python_strands/local"))).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await text(root, `.box/agent_python_strands/local/${name}`),
      ]),
    ),
  );
}

const userTarget = (name: string, endpoint: string, rest: object = {}) => ({
  name,
  targetType: "passthrough",
  passthrough: { endpoint, protocolType: "CUSTOM" },
  ...rest,
});

describe("build writes the Box network of the box profile", () => {
  test("gives each host Box allows a target, and routes it through the gateway on the Runtime", async () => {
    const { manager, root, counter, box } = await strandsProject();
    await editProfile(root, {
      top: 'policies = ["policy.dw"]\n',
      tables: GITHUB_ROUTE,
      policy: POLICY,
    });
    box.answer = shows({ github: GITHUB }, POLICY);
    const before = await boxFiles(root);

    const { steps } = await build(manager, root);

    expect(counter.specWrites).toBe(1);
    // create declares no target, so build adds the egress targets first, then bedrock and Memory.
    expect(await targetNames(root)).toEqual([
      "egress-github",
      "egress-httpbin-org",
      "bedrock",
      "agentcore",
    ]);
    const { targets } = await boxGateway(root);
    expect(targets[0]).toEqual(
      userTarget("egress-github", "https://api.github.com", { outboundAuth: GITHUB_KEY }),
    );
    expect(targets[1]).toEqual(userTarget("egress-httpbin-org", "https://httpbin.org"));
    expect(steps).toContain(
      `adding gateway target 'egress-github' to '${GATEWAY}' for api.github.com`,
    );

    // The Runtime profile routes each target of the Box gateway, as upstream renders it.
    const profile = await runtimeProfile(root);
    expect(profile.policies).toEqual(["policy.dw"]);
    expect(await text(root, "app/agent_python_strands/.box-dist/policy.dw")).toBe(POLICY);
    const egress = profile.egress as Record<string, unknown>;
    expect(Object.keys(egress)).toEqual([
      "egress-github",
      "egress-httpbin-org",
      "bedrock",
      "agentcore",
    ]);
    expect(egress["egress-github"]).toEqual({
      destinations: ["api.github.com"],
      backends: GATEWAY_BACKEND("egress-github"),
    });
    expect(egress["egress-httpbin-org"]).toEqual({
      destinations: ["httpbin.org"],
      backends: GATEWAY_BACKEND("egress-httpbin-org"),
    });
    expect(await boxFiles(root)).toEqual(before);
  });

  test("gives an HTTP MCP server a target and its API key credential, and keeps it an [mcp] server on the Runtime", async () => {
    const { manager, root, box } = await strandsProject();
    const tools = {
      type: "http",
      destinations: ["tools.example.com"],
      secret: { ref: "env://TOOLS_TOKEN" },
    };
    await editProfile(root, {
      tables:
        '\n[mcp.tools]\ntype = "http"\ndestinations = ["tools.example.com"]\n' +
        'secret.ref = "env://TOOLS_TOKEN"\n',
    });
    box.answer = boxShowOf({ egress: { bedrock: BEDROCK }, mcp: { tools } });

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["egress-tools", "bedrock", "agentcore"]);
    const { targets } = await boxGateway(root);
    // A CUSTOM passthrough target, so Box alone decides each mcp:call.
    expect(targets[0]).toEqual(
      userTarget("egress-tools", "https://tools.example.com", {
        outboundAuth: { ...GITHUB_KEY, credentialName: "tools" },
      }),
    );
    expect(JSON.parse(await text(root, SPEC)).credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "tools",
    });
    expect(steps).toContain("adding API key credential 'tools' for env://TOOLS_TOKEN");
    const profile = await runtimeProfile(root);
    expect(Object.keys(profile.egress as object)).toEqual(["bedrock", "agentcore"]);
    expect(profile.mcp).toEqual({
      tools: { ...tools, backends: GATEWAY_BACKEND("egress-tools") },
    });
  });

  test("leaves the user's other gateways as written, with no defaults added", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    const spec = JSON.parse(await text(root, SPEC));
    const tools = { name: "tools", authorizerType: "AWS_IAM", targets: [] };
    spec.agentCoreGateways.push(tools);
    await writeFile(path(root, SPEC), JSON.stringify(spec));

    await build(manager, root);

    const gateways = JSON.parse(await text(root, SPEC)).agentCoreGateways;
    expect(gateways.find(({ name }: { name: string }) => name === "tools")).toStrictEqual(tools);
    expect(await targetNames(root)).toContain("egress-github");
  });

  test("changes nothing on a second build", async () => {
    const { manager, root, counter, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    await build(manager, root);
    const spec = await text(root, SPEC);
    const profile = await text(root, RUNTIME_PROFILE);
    counter.specWrites = 0;

    const { steps } = await build(manager, root);

    expect(steps).toEqual(["synthesizing CloudFormation templates"]);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(await text(root, RUNTIME_PROFILE)).toBe(profile);
  });

  test("routes a host through the target the gateway holds for it, and keeps every user target", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    await editGateway(root, (gateway) => {
      gateway.targets.push(
        userTarget("gh", "https://api.github.com:443", { outboundAuth: GITHUB_KEY }),
        userTarget("weather", "https://weather.example.com"),
      );
    });

    await build(manager, root);

    expect(await targetNames(root)).toEqual(["gh", "weather", "bedrock", "agentcore"]);
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(egress.gh).toMatchObject({ destinations: ["api.github.com"] });
  });

  test("removes a target it added when the profile no longer allows its host, and only that one", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    await build(manager, root);
    const profile = await text(root, ".box/agent_python_strands/local/profile.toml");
    await writeFile(
      path(root, ".box/agent_python_strands/local/profile.toml"),
      profile.replace(GITHUB_ROUTE, ""),
    );
    box.answer = shows();

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    expect(steps).toContain(
      `removing gateway target 'egress-github' from '${GATEWAY}': the Box profile no longer ` +
        "allows api.github.com",
    );
  });

  test("gives the Memory endpoint to the agentcore target, and adds no second target for it", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, {
      tables:
        '\n[egress.memory]\ndestinations = ["bedrock-agentcore.us-west-2.amazonaws.com"]\n' +
        'secret.ref = "aws://default"\n',
    });
    box.answer = shows({
      memory: {
        destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
        secret: { ref: "aws://default" },
      },
    });

    await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(Object.keys(egress)).toEqual(["bedrock", "agentcore"]);
  });

  test("on a first build, stops with every problem, where it is, and writes nothing", async () => {
    const { manager, root, counter, box } = await strandsProject();
    const policy = [
      "// Every subdomain of example.com.",
      `@id("wild") permit (principal, ${HR}, resource) when { context.input.host like "*.example.com" };`,
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "a.example.com" };`,
      `@id("dup") forbid (principal, ${HR}, resource) when { context.input.host == "b.example.com" };`,
      "// A copy of the rule Box adds for [egress.github].",
      `@id("route_github_connect") permit (principal, ${NC}, resource) when { context.input.host == "api.github.com" };`,
      `permit (principal, ${HR}, resource);`,
      "",
    ].join("\n");
    await editProfile(root, {
      top: 'policies = ["policy.dw"]\n',
      tables:
        '\n[egress.github]\ndestinations = ["api.github.com"]\n' +
        '\n[egress.signed]\ndestinations = ["api.example.com"]\nsecret.ref = "aws://default"\n' +
        '\n[egress.wide]\ndestinations = ["*.wide.example.com"]\nsecret.ref = "env://WIDE_KEY"\n' +
        '\n[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com/mcp"]\n',
      policy,
    });
    await editGateway(root, (gateway) => {
      gateway.targets.push(
        userTarget("gh", "https://api.github.com", { outboundAuth: GITHUB_KEY }),
      );
    });
    // Box resolves the packs too: one adds [egress.legacy] and a rule of its own.
    box.answer = boxShowOf({
      egress: {
        bedrock: BEDROCK,
        github: { destinations: ["api.github.com"] },
        signed: { destinations: ["api.example.com"], secret: { ref: "aws://default" } },
        wide: { destinations: ["*.wide.example.com"], secret: { ref: "env://WIDE_KEY" } },
        legacy: { destinations: ["legacy.example.com"], secret: { ref: "credsd://prod" } },
      },
      mcp: { docs: { type: "http", destinations: ["docs.example.com/mcp"] } },
      policy:
        policy +
        `@id("pack_mirrors") permit (principal, ${HR}, resource) when { context.input.host like "*.mirror.example.com" };\n`,
    });
    const spec = await text(root, SPEC);
    const envLocal = await text(root, "agentcore/.env.local");
    const before = await boxFiles(root);

    const error = await build(manager, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InputValidationError);
    matchGolden(FIXTURES, "box-network-build-stopped.golden.txt", (error as Error).message);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, "agentcore/box-bedrock-policy.json"))).toBe(false);
    expect(existsSync(path(root, "agentcore/box-memory-policy.json"))).toBe(false);
    expect(await text(root, "agentcore/.env.local")).toBe(envLocal);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
    expect(await boxFiles(root)).toEqual(before);
  });

  test("warns once for each limit Box enforces that the gateway does not, and builds", async () => {
    const { manager, root, box } = await strandsProject();
    const policy = [
      `@id("no_admin") forbid (principal, ${HR}, resource) when { context.input.host == "api.github.com" && context.input.path like "/admin/*" };`,
      `@id("no_blocked") forbid (principal, ${NC}, resource) when { context.input.host == "blocked.example.com" };`,
      `@id("httpbin_connect") permit (principal, ${NC}, resource) when { context.input.host == "httpbin.org" };`,
      `@id("httpbin_get") permit (principal, ${HR}, resource) when { context.input.host == "httpbin.org" && context.input.method == "GET" };`,
      "",
    ].join("\n");
    const fn = {
      destinations: ["abc123.lambda-url.us-west-2.on.aws"],
      secret: { ref: "aws://default" },
    };
    await editProfile(root, {
      top: 'policies = ["policy.dw"]\n',
      tables:
        GITHUB_ROUTE +
        '\n[egress.blocked]\ndestinations = ["blocked.example.com"]\n' +
        '\n[egress.fn]\ndestinations = ["abc123.lambda-url.us-west-2.on.aws"]\n' +
        'secret.ref = "aws://default"\n',
      policy,
    });
    await writeFile(path(root, "agentcore/extra-policy.json"), "[]");
    await editGateway(root, (gateway) => {
      const entry = gateway as { additionalPolicies?: string[] };
      entry.additionalPolicies = [
        ...(entry.additionalPolicies ?? []),
        "agentcore/extra-policy.json",
      ];
    });
    box.answer = shows(
      { github: GITHUB, blocked: { destinations: ["blocked.example.com"] }, fn },
      policy,
    );

    const { warnings } = await build(manager, root);

    matchGolden(FIXTURES, "box-network-build-warnings.golden.txt", warnings.join("\n"));
  });

  test("warns for an IAM policy file of the Box gateway that is not JSON, and builds", async () => {
    const { manager, root } = await strandsProject();
    await writeFile(path(root, "agentcore/extra-policy.json"), "{ not json");
    await editGateway(root, (gateway) => {
      (gateway as { additionalPolicies?: string[] }).additionalPolicies = [
        "agentcore/extra-policy.json",
      ];
    });

    const { warnings } = await build(manager, root);

    expect(warnings).toContainEqual(
      expect.stringContaining(
        `agentcore/extra-policy.json, in additionalPolicies of the gateway '${GATEWAY}', is not ` +
          "valid JSON (",
      ),
    );
  });

  test("refuses a target of the user's whose outbound auth differs from the entry's", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    await editGateway(root, (gateway) => {
      gateway.targets.push(userTarget("gh", "https://api.github.com"));
    });
    const spec = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toThrow(
      "Build stopped: 1 problem in agentcore.json. Nothing was changed.\n" +
        "agentcore/agentcore.json  The gateway target 'gh' for api.github.com sends no " +
        "credential, and [egress.github] sends the API key credential 'github' in the header " +
        "Authorization with the prefix Bearer. Make the two the same, in agentcore.json or in " +
        ".box/agent_python_strands/local/profile.toml.",
    );
    expect(await text(root, SPEC)).toBe(spec);
  });
});

describe("build reads the box profile as box resolves it", () => {
  test("takes the route a pack adds, which build refused when it compiled the profile itself", async () => {
    const { manager, root, box } = await strandsProject();
    const profile = await text(root, ".box/agent_python_strands/local/profile.toml");
    await writeFile(
      path(root, ".box/agent_python_strands/local/profile.toml"),
      profile.replace('"box/bedrock"]', '"box/bedrock", "box/anthropic"]'),
    );
    // `box profile show --format json --full` resolves box/anthropic to this route, with its
    // secret.
    box.answer = shows({
      anthropic: {
        destinations: ["api.anthropic.com"],
        secret: { header: "x-api-key", phantom_prefix: "sk-ant-", ref: "env://ANTHROPIC_API_KEY" },
      },
    });

    await build(manager, root);

    expect(box.calls).toEqual([
      { projectRoot: root, profilePath: ".box/agent_python_strands/local/profile.toml" },
    ]);
    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "egress-anthropic")).toEqual(
      userTarget("egress-anthropic", "https://api.anthropic.com", {
        outboundAuth: {
          type: "API_KEY",
          credentialName: "anthropic",
          location: "HEADER",
          parameterName: "x-api-key",
        },
      }),
    );
  });

  test("stops with box's error when box refuses the profile, and writes nothing", async () => {
    const { manager, root, counter, box } = await strandsProject();
    box.answer = new InvalidEnvironmentError(
      "`box profile show .box/agent_python_strands/local/profile.toml --format json --full` failed in the project (exit code 1)",
    );
    const spec = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toBe(box.answer);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
  });
});

describe("build writes the telemetry policy of the box profile", () => {
  const TELEMETRY_POLICY = "agentcore/box-telemetry-policy-agent_python_strands.json";
  const ENTRY = "../../agentcore/box-telemetry-policy-agent_python_strands.json";
  const LOGS = {
    kind: "cloudwatch_logs",
    region: "us-west-2",
    log_group: "my-group",
    log_stream: "my-stream",
    secret: { ref: "aws://my-profile" },
  };
  const TRACES = {
    kind: "cloudwatch_traces",
    region: "us-west-2",
    secret: { ref: "aws://my-profile" },
  };
  const LOGS_STATEMENT = {
    Sid: "BoxTelemetryToCloudWatchLogs",
    Effect: "Allow",
    Action: ["logs:PutLogEvents"],
    Resource: ["arn:aws:logs:us-west-2:*:log-group:my-group:log-stream:my-stream"],
  };
  const TRACES_STATEMENT = {
    Sid: "BoxTelemetryToXRay",
    Effect: "Allow",
    Action: ["xray:PutSpans"],
    Resource: "*",
  };
  const ADDED =
    `adding ${TELEMETRY_POLICY} to additionalPolicies of 'agent_python_strands', so its box can ` +
    "send telemetry to CloudWatch";

  /** What box resolves the created profile to, with `telemetry` as its [telemetry] tables. */
  const showsTelemetry = (telemetry: Record<string, unknown>) => {
    const answer = shows();
    return { ...answer, boxToml: { ...answer.boxToml, telemetry } };
  };

  async function runtimeEntry(root: string) {
    const spec = JSON.parse(await text(root, SPEC));
    return spec.runtimes[0] as { codeLocation: string; additionalPolicies?: string[] };
  }

  test.each([
    ["CloudWatch Logs", { logs: LOGS }, [LOGS_STATEMENT]],
    ["X-Ray", { traces: TRACES }, [TRACES_STATEMENT]],
    ["both", { logs: LOGS, traces: TRACES }, [LOGS_STATEMENT, TRACES_STATEMENT]],
  ])(
    "for %s, writes the grant and lists it on the box runtime",
    async (_label, telemetry, statements) => {
      const { manager, root, box } = await strandsProject();
      box.answer = showsTelemetry(telemetry);

      const { steps } = await build(manager, root);

      expect(JSON.parse(await text(root, TELEMETRY_POLICY))).toEqual({
        Version: "2012-10-17",
        Statement: statements,
      });
      const runtime = await runtimeEntry(root);
      expect(runtime.additionalPolicies).toEqual([ENTRY]);
      // The CDK library reads a runtime's policy files from its codeLocation.
      expect(join(root, runtime.codeLocation, ENTRY)).toBe(path(root, TELEMETRY_POLICY));
      expect(steps).toContain(ADDED);
      expect(steps).toContain(`writing ${TELEMETRY_POLICY}`);
    },
  );

  test("copies both CloudWatch targets into the Runtime profile, signed with a bare aws://", async () => {
    const { manager, root, box } = await strandsProject();
    const records = { kind: "file", destination: "/tmp/records.jsonl" };
    box.answer = showsTelemetry({ logs: LOGS, traces: TRACES, records });

    await build(manager, root);

    // On the Runtime, a bare aws:// signs with the execution role that the policy file grants.
    expect((await runtimeProfile(root)).telemetry).toEqual({
      logs: { ...LOGS, secret: { ref: "aws://" } },
      traces: { ...TRACES, secret: { ref: "aws://" } },
    });
    expect(await text(root, RUNTIME_PROFILE)).not.toContain("my-profile");
  });

  test("changes nothing on a second build", async () => {
    const { manager, root, counter, box } = await strandsProject();
    box.answer = showsTelemetry({ logs: LOGS, traces: TRACES });
    await build(manager, root);
    const policy = await text(root, TELEMETRY_POLICY);
    counter.specWrites = 0;

    const { steps } = await build(manager, root);

    expect(steps).toEqual(["synthesizing CloudFormation templates"]);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, TELEMETRY_POLICY)).toBe(policy);
  });

  test("writes no file and lists nothing when the profile sends no telemetry to CloudWatch", async () => {
    const { manager, root, box } = await strandsProject();
    // A third-party target with no key needs no grant.
    box.answer = showsTelemetry({
      collector: { kind: "otlp", destination: "https://collector.example.com" },
    });

    const { steps } = await build(manager, root);

    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
    expect((await runtimeEntry(root)).additionalPolicies).toBeUndefined();
    expect(steps.filter((step) => step.includes(TELEMETRY_POLICY))).toEqual([]);
  });

  test("removes the file and the entry when the profile no longer sends telemetry to CloudWatch", async () => {
    const { manager, root, box } = await strandsProject();
    box.answer = showsTelemetry({ logs: LOGS });
    await build(manager, root);
    box.answer = shows();

    const { steps } = await build(manager, root);

    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
    expect((await runtimeEntry(root)).additionalPolicies).toBeUndefined();
    expect(steps).toContain(
      `removing ${TELEMETRY_POLICY} from additionalPolicies of 'agent_python_strands': its box ` +
        "sends no telemetry to CloudWatch",
    );
    expect(steps).toContain(`removing ${TELEMETRY_POLICY}`);
  });

  describe("for a target with no region", () => {
    const { region: _region, ...REGIONLESS_LOGS } = LOGS;
    const logsIn = (region: string) => ({ ...LOGS, region, secret: { ref: "aws://" } });
    const statementIn = (region: string) => ({
      ...LOGS_STATEMENT,
      Resource: [`arn:aws:logs:${region}:*:log-group:my-group:log-stream:my-stream`],
    });
    const DEFAULT_TARGET = [{ name: "default", account: "111122223333", region: "eu-west-1" }];

    test("sets the region build builds for in the Runtime profile and the grant, adds no default target, and warns that dev needs a region", async () => {
      const { manager, root, box } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
      box.answer = showsTelemetry({ logs: REGIONLESS_LOGS });

      const { warnings } = await build(manager, root);

      expect((await runtimeProfile(root)).telemetry).toEqual({ logs: logsIn("eu-central-1") });
      expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([
        statementIn("eu-central-1"),
      ]);
      expect(warnings).toContain(
        ".box/agent_python_strands/local/profile.toml: [telemetry.logs] has no region, so build " +
          "sets eu-central-1, the deploy region, in the AgentCore Runtime profile. Box refuses a " +
          "CloudWatch target with no region, so `agentcore dev` cannot run this profile until " +
          "you add region to it.",
      );
    });

    test("on build, sets the region of the default deploy target, and keeps the Bedrock region and a target's own region", async () => {
      const { manager, root, box } = await strandsProject();
      box.answer = showsTelemetry({ logs: REGIONLESS_LOGS, traces: TRACES });
      await writeFile(path(root, "agentcore/aws-targets.json"), JSON.stringify(DEFAULT_TARGET));

      await build(manager, root);

      const profile = await runtimeProfile(root);
      expect(profile.telemetry).toEqual({
        logs: logsIn("eu-west-1"),
        traces: { ...TRACES, secret: { ref: "aws://" } },
      });
      expect(profile.options).toEqual({ bedrock: { region: "us-west-2" } });
      expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([
        statementIn("eu-west-1"),
        TRACES_STATEMENT,
      ]);
    });

    test("on deploy, sets the region of its target", async () => {
      const calls: DeployBackendInput[] = [];
      const backend: ProjectBackend = {
        async *build() {},
        async *deploy(_project, input) {
          calls.push(input);
          yield { type: "step", message: "deploying" };
          return { outputs: {} };
        },
        async resolveDeployedResources() {
          return [];
        },
        async resolveProjectResources() {
          return [];
        },
      };
      const { manager, root, box } = await strandsProject({ backends: { CDK: backend } });
      box.answer = showsTelemetry({ logs: REGIONLESS_LOGS });
      await writeFile(
        path(root, "agentcore/aws-targets.json"),
        JSON.stringify([
          ...DEFAULT_TARGET,
          { name: "primary", account: "111122223333", region: "ap-south-1" },
        ]),
      );

      const project = (await manager.resolve({ filePath: root })) as Project;
      await drain(
        manager.deploy(project, {
          target: "primary",
          region: "us-west-2",
          confirmTeardown: async () => false,
        }),
      );

      const [network] = calls[0]!.boxNetworks;
      const runtime = project.spec.runtimes[0]!;
      expect(parse(renderRuntimeBoxProfile(project.spec, runtime, network)).telemetry).toEqual({
        logs: logsIn("ap-south-1"),
      });
      expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([
        statementIn("ap-south-1"),
      ]);
    });
  });
});

describe("build moves the key of a third-party telemetry target to AWS Secrets Manager", () => {
  const TELEMETRY_POLICY = "agentcore/box-telemetry-policy-agent_python_strands.json";
  const ENTRY = "../../agentcore/box-telemetry-policy-agent_python_strands.json";
  const SECRET = "agentcore/demo/agent_python_strands/box";
  /** The switch that turns the move on, which is off by default. */
  const ON = { AGENTCORE_BOX_SECRETS_MANAGER: "1" };
  const VARIABLE = "AGENTCORE_CREDENTIAL_AGENT_PYTHON_STRANDS_TELEMETRY_LANGSMITH";
  /** A stand-in key, which the test looks for in each file build writes. */
  const KEY = "dummy-langsmith-key";
  const LANGSMITH = {
    kind: "langsmith",
    project: "box",
    include: ["trace"],
    secret: { ref: "env://LANGSMITH_KEY" },
  };
  /** The default target of the Runtime profile, as the box profile has no cloudwatch_logs target. */
  const DEFAULT_TARGET = {
    kind: "cloudwatch_logs",
    region: "us-west-2",
    log_group: "/aws/bedrock-agentcore/box/demo/agent_python_strands",
    log_stream: "box",
    include: ["deny", "permit", "trace"],
    secret: { ref: "aws://" },
  };

  const showsTelemetry = (telemetry: Record<string, unknown>) => {
    const answer = shows();
    return { ...answer, boxToml: { ...answer.boxToml, telemetry } };
  };

  test("names the secret in the Runtime profile, and lets the execution role read it alone", async () => {
    const { manager, root, box } = await strandsProject({
      env: { ...ON, LANGSMITH_KEY: KEY },
      template: "agent-python-strands-box-container",
    });
    box.answer = showsTelemetry({ langsmith: LANGSMITH });

    const { steps, warnings } = await build(manager, root);

    const profile = await runtimeProfile(root);
    expect(profile.telemetry).toEqual({
      agentcore: DEFAULT_TARGET,
      langsmith: {
        kind: "langsmith",
        project: "box",
        include: ["trace"],
        secret: { ref: `aws-secretsmanager://${SECRET}#telemetry.langsmith` },
      },
    });
    expect(profile.plugins).toEqual(["box/aws-secrets-manager"]);
    // The image installs the AWS CLI, which box runs to read the key.
    expect(await text(root, "app/agent_python_strands/.box-dist/box-release.env")).toContain(
      "AWS_CLI_URL=https://awscli.amazonaws.com/awscli-exe-linux-aarch64-",
    );
    expect(JSON.parse(await text(root, TELEMETRY_POLICY))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BoxTelemetrySecrets",
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [`arn:aws:secretsmanager:us-west-2:*:secret:${SECRET}-??????`],
        },
      ],
    });
    const spec = JSON.parse(await text(root, SPEC));
    expect(spec.runtimes[0].additionalPolicies).toEqual([ENTRY]);
    // Deploy reads the key from .env.local; build copies it there from the profile's variable.
    expect(steps).toContain(`writing ${VARIABLE} to agentcore/.env.local`);
    expect(await text(root, "agentcore/.env.local")).toMatch(new RegExp(`^${VARIABLE}=.`, "m"));
    const staged = [RUNTIME_PROFILE, ".box/agent_python_strands/aws/profile.toml"];
    for (const file of [...staged, SPEC, TELEMETRY_POLICY]) {
      expect(await text(root, file)).not.toContain(KEY);
    }
    // The target declares no credential: deploy writes a secret, not an Identity provider.
    expect(spec.credentials).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("keeps today's Runtime profile with the switch off, and says why", async () => {
    const { manager, root, box } = await strandsProject({
      env: { LANGSMITH_KEY: KEY },
      template: "agent-python-strands-box-container",
    });
    box.answer = showsTelemetry({ langsmith: LANGSMITH });

    const { steps, warnings } = await build(manager, root);

    const profile = await runtimeProfile(root);
    expect(profile.telemetry).toEqual({ agentcore: DEFAULT_TARGET });
    expect(profile.plugins).toBeUndefined();
    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
    expect(steps.filter((step) => step.includes(VARIABLE))).toEqual([]);
    expect(await text(root, "app/agent_python_strands/.box-dist/box-release.env")).not.toContain(
      "AWS_CLI",
    );
    expect(warnings).toContain(
      ".box/agent_python_strands/local/profile.toml: the AgentCore Runtime profile leaves out " +
        "[telemetry.langsmith]: on AgentCore Runtime, Box reads its key from AWS Secrets Manager, " +
        "and no Box release for Linux can do that yet. To try a box build that can, set " +
        "AGENTCORE_BOX_SECRETS_MANAGER=1.",
    );
  });

  test("leaves out a target whose key the Runtime has no source for, and says so", async () => {
    const { manager, root, box } = await strandsProject({ env: ON });
    const collector = {
      kind: "otlp",
      destination: "https://collector.example.com",
      secret: { ref: "aws://my-profile" },
    };
    box.answer = showsTelemetry({ collector });

    const { warnings } = await build(manager, root);

    expect((await runtimeProfile(root)).telemetry).toEqual({ agentcore: DEFAULT_TARGET });
    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
    expect(warnings).toContain(
      ".box/agent_python_strands/local/profile.toml: the AgentCore Runtime profile leaves out " +
        "[telemetry.collector]: its `secret.ref` names no `env://` or `secret://` variable, and " +
        "build moves only such a key to AWS Secrets Manager.",
    );
  });
});

describe("build writes the Bedrock and Memory targets for the region it builds for", () => {
  const bedrockTarget = (region: string) => ({
    name: "bedrock",
    targetType: "passthrough",
    passthrough: {
      endpoint: `https://bedrock-runtime.${region}.amazonaws.com`,
      protocolType: "CUSTOM",
    },
    outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region },
  });

  test("takes AWS_REGION for the targets and the Runtime profile", async () => {
    const { manager, root } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });

    await build(manager, root);

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("eu-central-1"));
    expect(targets.find(({ name }) => name === "agentcore")).toMatchObject({
      passthrough: { endpoint: "https://bedrock-agentcore.eu-central-1.amazonaws.com" },
      outboundAuth: { region: "eu-central-1" },
    });
    const profile = await runtimeProfile(root);
    expect(profile.options).toEqual({ bedrock: { region: "eu-central-1" } });
    const egress = profile.egress as Record<string, { destinations: string[]; backends: unknown }>;
    expect(egress.bedrock!.destinations).toEqual(["bedrock-runtime.eu-central-1.amazonaws.com"]);
    // The backend signs for the Runtime's own region, which box reads from AWS_REGION there.
    expect(JSON.stringify(egress.bedrock!.backends)).toContain(
      '"region":"${{ inputs.aws.region }}"',
    );
  });

  /** Sets the profile's Bedrock region, as a user does to call Bedrock elsewhere under dev. */
  async function setDevRegion(root: string, region: string) {
    const profile = await text(root, ".box/agent_python_strands/local/profile.toml");
    const edited = profile.replace(/^bedrock\.region = ".*"$/m, `bedrock.region = "${region}"`);
    expect(edited).not.toBe(profile);
    await writeFile(path(root, ".box/agent_python_strands/local/profile.toml"), edited);
  }

  test("has box resolve the profile for that region, from a copy it then removes", async () => {
    const { manager, root, box } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
    await setDevRegion(root, "us-west-2");
    const before = await boxFiles(root);

    await build(manager, root);

    // box/bedrock's route is for eu-central-1, so the bedrock target serves it, and no
    // egress-bedrock target is added for the us-west-2 host that `agentcore dev` calls.
    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    const [call] = box.calls;
    expect(isAbsolute(call!.profilePath)).toBe(true);
    expect(existsSync(call!.profilePath)).toBe(false);
    expect(parse(box.profiles[0]!).options).toEqual({ bedrock: { region: "eu-central-1" } });
    expect(box.profiles[0]!.split("\n").length).toBe(before["profile.toml"]!.split("\n").length);
    expect(await boxFiles(root)).toEqual(before);
  });

  test("names the profile, not the copy, when box refuses the copy", async () => {
    const { manager, root, box } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
    await setDevRegion(root, "us-west-2");
    box.resolve = async (_, profilePath) => {
      throw new InvalidEnvironmentError(
        `Box refused the profile ${profilePath}:\n  box: error: ${profilePath}:4: bad\n` +
          "Fix what Box reports, then retry.",
      );
    };

    await expect(build(manager, root)).rejects.toThrow(
      "Box refused the profile .box/agent_python_strands/local/profile.toml:\n  box: error: .box/agent_python_strands/local/profile.toml:4: bad\n",
    );
  });

  test("takes AWS_DEFAULT_REGION when AWS_REGION is unset", async () => {
    const { manager, root } = await strandsProject({
      env: { AWS_REGION: undefined, AWS_DEFAULT_REGION: "ap-southeast-2" },
    });

    await build(manager, root);

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("ap-southeast-2"));
  });

  test("moves a target it wrote for another region, and keeps one the user changed", async () => {
    const { manager, root } = await strandsProject();
    await build(manager, root);
    await editGateway(root, (gateway) => {
      gateway.targets = gateway.targets.map((target) => {
        const { name } = target as { name: string };
        if (name === "bedrock") return bedrockTarget("us-east-1");
        if (name === "agentcore") {
          return {
            ...(target as object),
            passthrough: { endpoint: "https://memory.example.com", protocolType: "CUSTOM" },
            outboundAuth: {
              type: "GATEWAY_IAM_ROLE",
              service: "bedrock-agentcore",
              region: "eu-west-1",
            },
          };
        }
        return target;
      });
    });

    const { steps } = await build(manager, root);

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("us-west-2"));
    expect(steps).toContain(
      `updating gateway target 'bedrock' of '${GATEWAY}' from us-east-1 to us-west-2`,
    );
    expect(targets.find(({ name }) => name === "agentcore")).toMatchObject({
      passthrough: { endpoint: "https://memory.example.com" },
    });
  });
});

describe("deploy writes the Box network before the backend deploys", () => {
  test("with no earlier build, declares the credential, seeds its key, and hands the backend the models", async () => {
    const calls: { project: Project; input: DeployBackendInput }[] = [];
    const backend: ProjectBackend = {
      async *build() {},
      async *deploy(project, input) {
        calls.push({ project, input });
        yield { type: "step", message: "deploying" };
        return { outputs: {} };
      },
      async resolveDeployedResources() {
        return [];
      },
      async resolveProjectResources() {
        return [];
      },
    };
    const { manager, root, box } = await strandsProject({
      backends: { CDK: backend },
      env: { GITHUB_TOKEN: "ghp_123" },
    });
    box.answer = shows({ github: GITHUB });
    await writeFile(
      path(root, "agentcore/aws-targets.json"),
      JSON.stringify([{ name: "primary", account: "111122223333", region: "eu-west-1" }]),
    );
    await editProfile(root, { tables: GITHUB_ROUTE });

    const project = (await manager.resolve({ filePath: root })) as Project;
    await drain(
      manager.deploy(project, {
        target: "primary",
        region: "us-west-2",
        confirmTeardown: async () => false,
      }),
    );

    expect(calls).toHaveLength(1);
    const { spec } = calls[0]!.project;
    const gateway = spec.agentCoreGateways.find(({ name }) => name === GATEWAY);
    expect(gateway?.targets.map(({ name }) => name)).toEqual([
      "egress-github",
      "bedrock",
      "agentcore",
    ]);
    // Deploy writes the targets for its target's region, not the AWS_REGION build would take.
    expect(gateway?.targets.find(({ name }) => name === "bedrock")?.outboundAuth?.region).toBe(
      "eu-west-1",
    );
    expect(calls[0]!.input.boxNetworks.map(({ region }) => region)).toEqual(["eu-west-1"]);
    expect(spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });
    expect(calls[0]!.input.boxNetworks.map(({ gateway: name }) => name)).toEqual([GATEWAY]);
    expect(await text(root, "agentcore/.env.local")).toMatch(/^AGENTCORE_CREDENTIAL_GITHUB=./m);
  });

  test("moves the Memory policy with the agentcore target to the region of its target", async () => {
    const backend: ProjectBackend = {
      async *build() {},
      async *deploy() {
        yield { type: "step", message: "deploying" };
        return { outputs: {} };
      },
      async resolveDeployedResources() {
        return [];
      },
      async resolveProjectResources() {
        return [];
      },
    };
    const { manager, root } = await strandsProject({ backends: { CDK: backend } });
    const memoryStatements = async () =>
      JSON.parse(await text(root, "agentcore/box-memory-policy.json")).Statement as unknown[];
    const agentcoreAuth = async () =>
      (await boxGateway(root)).targets.find(({ name }) => name === "agentcore")?.outboundAuth;
    const statementsFor = (region: string) => [
      expect.objectContaining({
        Resource: [
          `arn:aws:bedrock-agentcore:${region}:*:memory/demo_*agent_python_strandsMemory-*`,
        ],
        Condition: { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } },
      }),
    ];
    await build(manager, root);
    expect(await agentcoreAuth()).toMatchObject({ region: "us-west-2" });
    expect(await memoryStatements()).toEqual(statementsFor("us-west-2"));
    await writeFile(
      path(root, "agentcore/aws-targets.json"),
      JSON.stringify([{ name: "primary", account: "111122223333", region: "eu-west-1" }]),
    );

    const project = (await manager.resolve({ filePath: root })) as Project;
    const { steps } = await drain(
      manager.deploy(project, {
        target: "primary",
        region: "us-west-2",
        confirmTeardown: async () => false,
      }),
    );

    expect(steps).toContain(
      `updating gateway target 'agentcore' of '${GATEWAY}' from us-west-2 to eu-west-1`,
    );
    expect(await agentcoreAuth()).toMatchObject({ region: "eu-west-1" });
    expect(await memoryStatements()).toEqual(statementsFor("eu-west-1"));
  });
});
