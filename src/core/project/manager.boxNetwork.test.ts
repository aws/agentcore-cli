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
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";
import type { ResolvedBoxProfile } from "./boxProfileResolver";
import { seedBoxCache } from "./backends/box-release-test-support";
import { FsProjectManager } from "./manager";

/** The golden files of this suite; `RECORD=1 bun test <this file>` rewrites them, with no AWS call. */
const FIXTURES = join(import.meta.dir, "__fixtures__");
const GATEWAY = "agent-python-strands-box-egress";
const SPEC = "agentcore/agentcore.json";
const PROFILE = ".box/profile.toml";
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
/** The route of a gateway target in the Runtime profile, as the Runtime profile renders it. */
const gatewayRoute = (target: string, host: string) => ({
  destinations: [host],
  backends: [
    {
      url: `\${{ inputs.gateway.url }}/${target}`,
      auth: { ref: "aws://", aws: { service: "bedrock-agentcore", region: "us-west-2" } },
    },
  ],
});

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
  options: { backends?: { CDK: ProjectBackend }; env?: NodeJS.ProcessEnv } = {},
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
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands-box", {
        runtimeName: "agent_python_strands",
      }),
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

/** Adds `tables` to the end of the profile, `top` to its start, and writes `.box/policy.dw`. */
async function editProfile(root: string, edit: { top?: string; tables?: string; policy?: string }) {
  const profile = await text(root, PROFILE);
  await writeFile(path(root, PROFILE), `${edit.top ?? ""}${profile}${edit.tables ?? ""}`);
  if (edit.policy !== undefined) await writeFile(path(root, ".box/policy.dw"), edit.policy);
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

/** The text of every file under `.box/`, by path. */
async function boxFiles(root: string): Promise<Record<string, string>> {
  const names = (await readdir(path(root, ".box"))).sort();
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await text(root, `.box/${name}`)])),
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
    const { manager, root, counter, box } = await strandsProject({
      env: { GITHUB_TOKEN: "ghp_123" },
    });
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
    expect(targets.slice(0, 2)).toEqual([
      userTarget("egress-github", "https://api.github.com", { outboundAuth: GITHUB_KEY }),
      userTarget("egress-httpbin-org", "https://httpbin.org"),
    ]);
    expect(steps).toContain(
      `adding gateway target 'egress-github' to '${GATEWAY}' for api.github.com`,
    );
    expect(JSON.parse(await text(root, SPEC)).credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });

    // The Runtime profile routes each target of the Box gateway, the model's included.
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
    expect(egress["egress-github"]).toEqual(gatewayRoute("egress-github", "api.github.com"));
    expect(egress["egress-httpbin-org"]).toEqual(gatewayRoute("egress-httpbin-org", "httpbin.org"));
    expect(egress.bedrock).toEqual(
      gatewayRoute("bedrock", "bedrock-runtime.us-west-2.amazonaws.com"),
    );
    expect(await boxFiles(root)).toEqual(before);
  });

  test("leaves the user's other gateways as written, with no defaults added", async () => {
    const { manager, root, box } = await strandsProject({ env: { GITHUB_TOKEN: "ghp_123" } });
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
    // The Box gateway gets only the fields build changed.
    expect(Object.keys(await boxGateway(root))).not.toContain("enableSemanticSearch");
  });

  test("writes no target for an env:// route whose key build cannot find, and says what to set", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    expect(JSON.parse(await text(root, SPEC)).credentials ?? []).toEqual([]);
    expect(steps).toContain(
      `not adding gateway target 'egress-github' of '${GATEWAY}' for api.github.com: it sends ` +
        "the key of env://GITHUB_TOKEN, and agentcore.json has no API key credential 'github' " +
        "to hold it",
    );
  });

  test("changes nothing on a second build", async () => {
    const { manager, root, counter, box } = await strandsProject({
      env: { GITHUB_TOKEN: "ghp_123" },
    });
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
    const { manager, root, box } = await strandsProject({ env: { GITHUB_TOKEN: "ghp_123" } });
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
    const { manager, root, box } = await strandsProject({ env: { GITHUB_TOKEN: "ghp_123" } });
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    await build(manager, root);
    const profile = await text(root, PROFILE);
    await writeFile(path(root, PROFILE), profile.replace(GITHUB_ROUTE, ""));
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
    const before = await boxFiles(root);

    const error = await build(manager, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InputValidationError);
    matchGolden(FIXTURES, "box-network-build-stopped.golden.txt", (error as Error).message);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, "agentcore/box-memory-policy.json"))).toBe(false);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
    expect(await boxFiles(root)).toEqual(before);
  });

  test("warns once for each limit Box enforces that the gateway does not, and builds", async () => {
    const { manager, root, box } = await strandsProject({ env: { GITHUB_TOKEN: "ghp_123" } });
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
        ".box/profile.toml.",
    );
    expect(await text(root, SPEC)).toBe(spec);
  });
});

describe("build reads the box profile as box resolves it", () => {
  test("takes the route a pack adds, which the profile itself does not hold", async () => {
    const { manager, root, box } = await strandsProject({ env: { SEARCH_KEY: "key-1" } });
    const profile = await text(root, PROFILE);
    await writeFile(
      path(root, PROFILE),
      profile.replace('"box/bedrock"]', '"box/bedrock", "team/search"]'),
    );
    // `box profile show --format json --full` resolves team/search to this route, with its secret.
    box.answer = shows({
      search: {
        destinations: ["api.search.example.com"],
        secret: { header: "x-api-key", ref: "env://SEARCH_KEY" },
      },
    });

    await build(manager, root);

    expect(box.calls).toEqual([{ projectRoot: root, profilePath: PROFILE }]);
    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "egress-search")).toEqual(
      userTarget("egress-search", "https://api.search.example.com", {
        outboundAuth: {
          type: "API_KEY",
          credentialName: "search",
          location: "HEADER",
          parameterName: "x-api-key",
        },
      }),
    );
  });

  test("stops with box's error when box refuses the profile, and writes nothing", async () => {
    const { manager, root, counter, box } = await strandsProject();
    box.answer = new InvalidEnvironmentError(
      "`box profile show .box/profile.toml --format json --full` failed in the project (exit code 1)",
    );
    const spec = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toBe(box.answer);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
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
    expect(JSON.stringify(egress.bedrock!.backends)).toContain('"region":"eu-central-1"');
  });

  test("has box resolve the profile for that region, from a copy it then removes", async () => {
    // create wrote the profile for us-west-2, the region `agentcore dev` calls Bedrock in.
    const { manager, root, box } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
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
    box.resolve = async (_, profilePath) => {
      throw new InvalidEnvironmentError(
        `Box refused the profile ${profilePath}:\n  box: error: ${profilePath}:4: bad\n` +
          "Fix what Box reports, then retry.",
      );
    };

    await expect(build(manager, root)).rejects.toThrow(
      `Box refused the profile ${PROFILE}:\n  box: error: ${PROFILE}:4: bad\n`,
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

  test("takes the region of the AWS config profile that its environment names", async () => {
    const config = join(await temporary("agentcore-aws-config-"), "config");
    await writeFile(config, "[default]\nregion = us-east-1\n[profile work]\nregion = eu-west-2\n");
    const { manager, root } = await strandsProject({
      env: { AWS_REGION: undefined, AWS_CONFIG_FILE: config, AWS_PROFILE: "work" },
    });

    await build(manager, root);

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("eu-west-2"));
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
      `updating target 'bedrock' of gateway '${GATEWAY}' in agentcore.json from us-east-1 to us-west-2`,
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
});
