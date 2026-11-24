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
import type { BoxNetwork } from "./boxNetwork";
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";
import type { ResolvedBoxProfile } from "./boxProfileResolver";
import { seedBoxCache } from "./backends/box-release-test-support";
import { BOX_RELEASE } from "./backends/boxRelease";
import { boxGatewayLogsNotice, FsProjectManager } from "./manager";
import { renderAwsMetadataPolicy } from "./templates/boxProfile";
import type { PassthroughGatewayCheck } from "./backends/cdk/compatibility";

/** The golden files of this suite; `RECORD=1 bun test <this file>` rewrites them, with no AWS call. */
const FIXTURES = join(import.meta.dir, "__fixtures__");
const GATEWAY = "agent-python-strands-box-egress";
const SPEC = "agentcore/agentcore.json";
const PROFILE = ".box/agent_python_strands/local/profile.toml";
const RUNTIME_PROFILE = "app/agent_python_strands/.box-dist/profile.toml";
const HR = 'action == Box::Action::"http:request"';
const NC = 'action == Box::Action::"net:connect"';
const POLICY =
  "// httpbin.org has no [egress] entry; the policy alone opens one path of it.\n" +
  `@id("httpbin_connect") permit (principal, ${NC}, resource) when { context.input.host == "httpbin.org" };\n` +
  `@id("httpbin_get") permit (principal, ${HR}, resource) when { context.input.host == "httpbin.org" && context.input.path == "/get" };\n`;
const GITHUB_ROUTE =
  '\n[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
/** Box's resolution of the Bedrock route of the profile `create` writes, with @box/bedrock. */
const BEDROCK = {
  destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
  secret: { ref: "aws://" },
};
const GITHUB = { destinations: ["api.github.com"], secret: { ref: "env://GITHUB_TOKEN" } };
/** What box resolves the created profile to, with `routes` beside its Bedrock route. */
const shows = (routes: Record<string, unknown> = {}, policy?: string) =>
  boxShowOf({ egress: { bedrock: BEDROCK, ...routes }, policy });
/**
 * A fake box that resolves @box/bedrock for the Bedrock region of the profile it reads, as box does:
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
      auth: {
        ref: "aws://",
        aws: { service: "bedrock-agentcore", region: "${{ inputs.aws.region }}" },
      },
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
  options: {
    backends?: { CDK: ProjectBackend };
    env?: NodeJS.ProcessEnv;
    /** What the probe of agentcore/cdk answers; it refuses passthrough.gateway when absent. */
    acceptsPassthroughGateway?: boolean;
    /** What the probe answers, in place of `acceptsPassthroughGateway`; a test can change it. */
    check?: { current: PassthroughGatewayCheck };
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
    cdkAcceptsPassthroughGateway: async () =>
      options.check?.current ??
      (options.acceptsPassthroughGateway
        ? { accepts: true }
        : { accepts: false, reason: "refuses" }),
    ...(options.backends && { backends: options.backends }),
  });
  const { value: created, warnings: createWarnings } = await drain(
    manager.create({
      name: "demo",
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(
        options.template ?? "agent-python-strands-box",
        { runtimeName: "agent_python_strands" },
      ),
      // As the create command does: the profile calls Bedrock in the region create resolved.
      region: "us-west-2",
      skipInstall: true,
      skipGit: true,
    }),
  );
  const root = created.rootPath;
  // Build installs the CDK dependencies unless the library is there at the version create vends.
  const cdk = join(root, "agentcore", "cdk");
  const { dependencies } = JSON.parse(await readFile(join(cdk, "package.json"), "utf8"));
  const library = join(cdk, "node_modules", "@aws", "agentcore-cdk");
  await mkdir(library, { recursive: true });
  await writeFile(
    join(library, "package.json"),
    JSON.stringify({ version: dependencies["@aws/agentcore-cdk"] }),
  );
  counter.specWrites = 0;
  return { manager, root, counter, box, createWarnings };
}

const path = (root: string, relative: string) => join(root, ...relative.split("/"));
const text = (root: string, relative: string) => readFile(path(root, relative), "utf8");

/**
 * Adds `tables` to the end of the profile and, as a user adds rules of their own, writes `policy`
 * to `.box/agent_python_strands/local/policy.dw` and lists it under `policies` after the file that
 * create writes.
 */
async function editProfile(root: string, edit: { tables?: string; policy?: string }) {
  let profile = await text(root, PROFILE);
  if (edit.policy !== undefined) {
    const created = 'policies = ["aws-metadata-block.dw"]\n';
    expect(profile).toContain(created);
    profile = profile.replace(created, 'policies = ["aws-metadata-block.dw", "policy.dw"]\n');
    await writeFile(path(root, ".box/agent_python_strands/local/policy.dw"), edit.policy);
  }
  await writeFile(path(root, PROFILE), `${profile}${edit.tables ?? ""}`);
}

/** Changes the Box gateway entry of agentcore.json, as a user does by hand. */
async function editGateway(root: string, edit: (gateway: { targets: unknown[] }) => void) {
  const spec = JSON.parse(await text(root, SPEC));
  edit(spec.agentCoreGateways.find(({ name }: { name: string }) => name === GATEWAY));
  await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
}

/** Sets `instrumentation.enableOtel` of the runtime in agentcore.json. */
async function setOtel(root: string, enableOtel: boolean) {
  const spec = JSON.parse(await text(root, SPEC));
  spec.runtimes[0].instrumentation = { enableOtel };
  await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
}

/** Sets `DISABLE_ADOT_OBSERVABILITY` to `"true"` in the envVars of the runtime in agentcore.json. */
async function optOut(root: string) {
  const spec = JSON.parse(await text(root, SPEC));
  spec.runtimes[0].envVars = [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }];
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
    additionalPolicies?: string[];
    enableApplicationLogs?: boolean;
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
    const { manager, root, counter, box } = await strandsProject({
      env: { GITHUB_TOKEN: "ghp_123" },
    });
    await editProfile(root, {
      tables: GITHUB_ROUTE,
      policy: POLICY,
    });
    box.answer = shows({ github: GITHUB }, POLICY);
    const before = await boxFiles(root);

    const { steps } = await build(manager, root);

    expect(counter.specWrites).toBe(1);
    // create declares no target, so build adds the egress targets first, then bedrock. The agent's
    // Memory calls take no target: they go to Memory directly.
    expect(await targetNames(root)).toEqual(["egress-github", "egress-httpbin-org", "bedrock"]);
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
    expect(profile.policies).toEqual(["aws-metadata-block.dw", "policy.dw"]);
    expect(await text(root, "app/agent_python_strands/.box-dist/policy.dw")).toBe(POLICY);
    expect(await text(root, "app/agent_python_strands/.box-dist/aws-metadata-block.dw")).toBe(
      renderAwsMetadataPolicy(),
    );
    const egress = profile.egress as Record<string, unknown>;
    // The route of [egress.github] keeps the name of its entry, and goes to its target. The
    // Bedrock route is the api-key route of @box/bedrock, whose env:// secret box takes beside a
    // backend.
    expect(Object.keys(egress).sort()).toEqual([
      "agentcore",
      "bedrock-api-key",
      "egress-httpbin-org",
      "github",
    ]);
    expect(egress.github).toEqual(gatewayRoute("egress-github", "api.github.com"));
    expect(egress["egress-httpbin-org"]).toEqual(gatewayRoute("egress-httpbin-org", "httpbin.org"));
    // The Memory route has no backend: box signs it with the execution role, for Memory itself.
    expect(egress.agentcore).toEqual({
      destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
      secret: { ref: "aws://" },
    });
    expect(egress["bedrock-api-key"]).toEqual(
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

  test("create says that the Box gateway sends its logs, and how to stop them", async () => {
    const { createWarnings } = await strandsProject();

    expect(createWarnings).toContain(boxGatewayLogsNotice(GATEWAY));
  });

  test("stages the policy file create writes beside the profile it leaves as written", async () => {
    const { manager, root, box } = await strandsProject();
    box.answer = shows();

    await build(manager, root);

    expect((await runtimeProfile(root)).policies).toEqual(["aws-metadata-block.dw"]);
    expect(await text(root, "app/agent_python_strands/.box-dist/aws-metadata-block.dw")).toBe(
      renderAwsMetadataPolicy(),
    );
  });

  test("keeps the enableApplicationLogs of the Box gateway as the user wrote it", async () => {
    const { manager, root, box } = await strandsProject({ env: { GITHUB_TOKEN: "ghp_123" } });
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });
    expect((await boxGateway(root)).enableApplicationLogs).toBe(true);

    await editGateway(root, (gateway) => Object.assign(gateway, { enableApplicationLogs: false }));
    await build(manager, root);
    expect(await targetNames(root)).toContain("egress-github");
    expect((await boxGateway(root)).enableApplicationLogs).toBe(false);

    await editGateway(root, (gateway) => {
      delete (gateway as { enableApplicationLogs?: boolean }).enableApplicationLogs;
    });
    const profile = await text(root, PROFILE);
    await writeFile(path(root, PROFILE), profile.replace(GITHUB_ROUTE, ""));
    box.answer = shows();
    await build(manager, root);
    expect(await targetNames(root)).not.toContain("egress-github");
    expect("enableApplicationLogs" in (await boxGateway(root))).toBe(false);
  });

  test("writes no target for an env:// route whose key build cannot find, and says what to set", async () => {
    const { manager, root, box } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    box.answer = shows({ github: GITHUB });

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock"]);
    expect(JSON.parse(await text(root, SPEC)).credentials ?? []).toEqual([]);
    expect(steps).toContain(
      `not adding gateway target 'egress-github' of '${GATEWAY}' for api.github.com: it sends ` +
        "the key of env://GITHUB_TOKEN, and agentcore.json has no API key credential 'github' " +
        "to hold it",
    );
    // With no target, the Runtime profile has no route to api.github.com, as the old renderer.
    const egress = (await runtimeProfile(root)).egress as Record<
      string,
      { destinations: string[] }
    >;
    expect(Object.keys(egress).sort()).toEqual(["agentcore", "bedrock-api-key"]);
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

  test("gives an HTTP MCP server a target and its API key credential, and keeps it an [mcp] server on the Runtime", async () => {
    const { manager, root, box } = await strandsProject({ env: { TOOLS_TOKEN: "tools-123" } });
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

    const { steps, warnings } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["egress-tools", "bedrock"]);
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
    expect(steps).toContain(
      "adding API key credential 'tools' to agentcore.json for box egress 'env://TOOLS_TOKEN', " +
        "so deploy provisions it in AgentCore Identity",
    );
    expect(warnings).toEqual([]);
    const profile = await runtimeProfile(root);
    expect(Object.keys(profile.egress as object)).toEqual(["bedrock-api-key", "agentcore"]);
    expect(profile.mcp).toEqual({
      tools: { ...tools, backends: gatewayRoute("egress-tools", "tools.example.com").backends },
    });
  });

  test("stages no Runtime [mcp] server for an HTTP MCP server whose key build cannot find", async () => {
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

    expect(await targetNames(root)).toEqual(["bedrock"]);
    expect(steps).toContain(
      `not adding gateway target 'egress-tools' of '${GATEWAY}' for tools.example.com: it sends ` +
        "the key of env://TOOLS_TOKEN, and agentcore.json has no API key credential 'tools' " +
        "to hold it",
    );
    // With no target, the Runtime profile has no [mcp.tools] server, as it has no route above.
    expect((await runtimeProfile(root)).mcp).toBeUndefined();
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

    expect(await targetNames(root)).toEqual(["gh", "weather", "bedrock"]);
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(egress.github).toEqual(gatewayRoute("gh", "api.github.com"));
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

    expect(await targetNames(root)).toEqual(["bedrock"]);
    expect(steps).toContain(
      `removing gateway target 'egress-github' from '${GATEWAY}': the Box profile no longer ` +
        "allows api.github.com",
    );
  });

  test("sends an entry of the profile for the AgentCore host directly on the Runtime, with its name", async () => {
    const { manager, root, box } = await strandsProject();
    const host = "bedrock-agentcore.us-west-2.amazonaws.com";
    await editProfile(root, {
      tables: `\n[egress.tools]\ndestinations = ["${host}"]\nsecret.ref = "aws://default"\n`,
    });
    box.answer = shows({ tools: { destinations: [host], secret: { ref: "aws://default" } } });

    const { warnings } = await build(manager, root);

    // Code Interpreter, Browser, and Memory share that host, and box routes a connection by host
    // alone. So on the Runtime the entry goes to the host directly, signed with the execution
    // role, and it carries the Memory calls too.
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(Object.keys(egress)).toEqual(["bedrock-api-key", "tools"]);
    expect(egress.tools).toEqual({ destinations: [host], secret: { ref: "aws://" } });
    // The Runtime does not use a gateway target for the host, so build writes none, and gives no
    // warning about the gateway role's grants for one.
    expect(await targetNames(root)).toEqual(["bedrock"]);
    expect(warnings).not.toContainEqual(expect.stringContaining("Target 'egress-"));

    // A second build changes nothing.
    const spec = await text(root, SPEC);
    const again = await build(manager, root);
    expect(again.steps.filter((step) => step.includes("gateway target"))).toEqual([]);
    expect(await text(root, SPEC)).toBe(spec);
  });

  const AGENTCORE_HOST = "bedrock-agentcore.us-west-2.amazonaws.com";
  test.each([
    {
      form: "an HTTP [mcp] server",
      label: "[mcp.tools]",
      tables: `\n[mcp.tools]\ntype = "http"\ndestinations = ["${AGENTCORE_HOST}"]\nsecret.ref = "env://TOOLS_TOKEN"\n`,
      answer: {
        egress: { bedrock: BEDROCK },
        mcp: {
          tools: {
            type: "http",
            destinations: [AGENTCORE_HOST],
            secret: { ref: "env://TOOLS_TOKEN" },
          },
        },
      },
    },
    {
      form: "an [egress] entry",
      label: "[egress.tools]",
      tables: `\n[egress.tools]\ndestinations = ["${AGENTCORE_HOST}"]\nsecret.ref = "env://TOOLS_TOKEN"\n`,
      answer: {
        egress: {
          bedrock: BEDROCK,
          tools: { destinations: [AGENTCORE_HOST], secret: { ref: "env://TOOLS_TOKEN" } },
        },
      },
    },
    {
      form: "an [egress] entry with another host too",
      label: "[egress.tools]",
      tables: `\n[egress.tools]\ndestinations = ["${AGENTCORE_HOST}", "api.github.com"]\nsecret.ref = "env://TOOLS_TOKEN"\n`,
      answer: {
        egress: {
          bedrock: BEDROCK,
          tools: {
            destinations: [AGENTCORE_HOST, "api.github.com"],
            secret: { ref: "env://TOOLS_TOKEN" },
          },
        },
      },
    },
  ])(
    "stops for $form that sends an env:// key to the AgentCore host, and writes nothing",
    async ({ label, tables, answer }) => {
      const { manager, root, box } = await strandsProject({ env: { TOOLS_TOKEN: "tools-123" } });
      await editProfile(root, { tables });
      box.answer = boxShowOf(answer);
      const spec = await text(root, SPEC);

      const error = await build(manager, root).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      // With the default Memory, box sends every call to the AgentCore host directly, signed with
      // the execution role, so the key would never reach the server.
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as Error).message).toContain(
        `${label} sends env://TOOLS_TOKEN to ${AGENTCORE_HOST}. On AgentCore Runtime, runtime ` +
          "'agent_python_strands' has its default Memory, so box sends every call to that host " +
          "directly, signed with the execution role",
      );
      // Build provisions no credential that nothing would send.
      expect(await text(root, SPEC)).toBe(spec);
    },
  );

  test("stops for a user target named agentcore, the name of the Memory route, and keeps it", async () => {
    const { manager, root, box } = await strandsProject();
    const mine = {
      name: "agentcore",
      targetType: "passthrough",
      passthrough: { endpoint: "https://memory.example.com", protocolType: "CUSTOM" },
      outboundAuth: { type: "NONE" },
    };
    await editGateway(root, (gateway) => gateway.targets.push(mine));
    box.answer = shows({});

    const error = await build(manager, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Build does not remove a target of the user, and its route would take the Memory route's name.
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(
      `agentcore/agentcore.json  [egress.agentcore] is the name of the route that the agent's ` +
        "Memory calls take on AgentCore Runtime, to bedrock-agentcore.us-west-2.amazonaws.com. " +
        `Rename the 'agentcore' target of gateway '${GATEWAY}'.`,
    );
    expect((await boxGateway(root)).targets).toContainEqual(mine);
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
      "Build stopped: 1 problem in agentcore.json. Build wrote nothing from the Box profile.\n" +
        "agentcore/agentcore.json  The gateway target 'gh' for api.github.com sends no " +
        "credential, and [egress.github] sends the API key credential 'github' in the header " +
        "Authorization with the prefix Bearer. Make the two the same, in agentcore.json or in " +
        ".box/agent_python_strands/local/profile.toml.",
    );
    expect(await text(root, SPEC)).toBe(spec);
  });
});

describe("build routes the other gateways of the project for the boxed agent", () => {
  /** Adds the gateway `tools` without boundRuntime, as `agentcore add gateway` writes it. */
  async function addToolsGateway(root: string) {
    const spec = JSON.parse(await text(root, SPEC));
    spec.agentCoreGateways.push({
      name: "tools",
      authorizerType: "AWS_IAM",
      protocolType: "None",
      enableSemanticSearch: false,
      exceptionLevel: "NONE",
      targets: [],
    });
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
  }

  test("writes the target and the server when the @aws/agentcore-cdk of the project accepts passthrough.gateway", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    await addToolsGateway(root);

    const { warnings } = await build(manager, root);

    expect((await boxGateway(root)).targets).toContainEqual({
      name: "egress-gateway-tools",
      targetType: "passthrough",
      passthrough: { gateway: "tools", protocolType: "CUSTOM" },
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore" },
    });
    expect((await runtimeProfile(root)).mcp).toHaveProperty("tools");
    expect(warnings.filter((warning) => warning.includes("passthrough.gateway"))).toEqual([]);
  });

  test("lets remove gateway remove the gateway after a build, with the target build wrote for it", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    await addToolsGateway(root);
    const user = userTarget("mine", "https://mine.example.com");
    await editGateway(root, (gateway) => gateway.targets.push(user));
    await build(manager, root);
    expect(await targetNames(root)).toContain("egress-gateway-tools");

    const project = (await manager.resolve({ filePath: root })) as Project;
    await manager.removeResource(project, { resourceType: "gateway", name: "tools" });

    const spec = JSON.parse(await text(root, SPEC));
    expect(spec.agentCoreGateways.map(({ name }: { name: string }) => name)).toEqual([GATEWAY]);
    expect(await targetNames(root)).not.toContain("egress-gateway-tools");
    expect((await boxGateway(root)).targets).toContainEqual(user);
    // The next build writes no target for the gateway that is gone.
    await build(manager, root);
    expect(await targetNames(root)).not.toContain("egress-gateway-tools");
  });

  test("reads the project and removes the target after a build when the gateway gets boundRuntime", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    await addToolsGateway(root);
    await build(manager, root);
    expect(await targetNames(root)).toContain("egress-gateway-tools");
    const spec = JSON.parse(await text(root, SPEC));
    spec.agentCoreGateways.find(({ name }: { name: string }) => name === "tools").boundRuntime =
      "agent_python_strands";
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).not.toContain("egress-gateway-tools");
    expect(steps).toContain(
      "removing gateway target 'egress-gateway-tools' from 'agent-python-strands-box-egress': " +
        "the boxed agent no longer calls the gateway 'tools'",
    );
  });

  test("reads the project and removes the target when the gateway is gone from agentcore.json", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    await addToolsGateway(root);
    await build(manager, root);
    const spec = JSON.parse(await text(root, SPEC));
    spec.agentCoreGateways = spec.agentCoreGateways.filter(
      ({ name }: { name: string }) => name !== "tools",
    );
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));

    await build(manager, root);

    expect(await targetNames(root)).not.toContain("egress-gateway-tools");
  });

  test("add gateway gives one notice for a CUSTOM_JWT gateway, and build gives none", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    const project = (await manager.resolve({ filePath: root })) as Project;
    const jwt = {
      name: "secure",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["agentcore"],
        },
      },
      enableSemanticSearch: false,
      exceptionLevel: "NONE",
      protocolType: "MCP",
      targets: [],
    };

    const added = await drain(
      manager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: jwt,
      } as unknown as Parameters<FsProjectManager["addResource"]>[1]),
    );
    const built = await build(manager, root);

    const notice =
      "the gateway 'secure' takes CUSTOM_JWT tokens, and a Box gateway signs only with its IAM " +
      "role, so a boxed agent cannot call 'secure' on AgentCore Runtime, and build adds no route " +
      "to it. Set its authorizerType to AWS_IAM to let a boxed agent call it";
    expect(added.warnings).toEqual([notice]);
    expect(built.warnings.filter((warning) => warning.includes("CUSTOM_JWT"))).toEqual([]);
  });

  test("stops, and keeps the route of a host, when a new gateway takes the name of its target", async () => {
    const { manager, root, box } = await strandsProject({
      acceptsPassthroughGateway: true,
      env: { GITHUB_TOKEN: "ghp_123" },
    });
    await editProfile(root, {
      tables:
        '\n[egress.gateway-tools]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n',
    });
    box.answer = shows({ "gateway-tools": GITHUB });
    await build(manager, root);
    const before = await text(root, SPEC);
    expect(await targetNames(root)).toContain("egress-gateway-tools");
    await addToolsGateway(root);
    const added = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toThrow(
      "takes the gateway target 'egress-gateway-tools' for api.github.com",
    );

    expect(await text(root, SPEC)).toBe(added);
    expect(JSON.parse(before).agentCoreGateways[0].targets).toContainEqual(
      expect.objectContaining({
        name: "egress-gateway-tools",
        passthrough: { endpoint: "https://api.github.com", protocolType: "CUSTOM" },
      }),
    );
  });

  test.each([
    [
      { accepts: false, reason: "not-installed" },
      "build found no @aws/agentcore-cdk in agentcore/cdk. Run npm install in agentcore/cdk, then build again.",
    ],
    [
      { accepts: false, reason: "no-node" },
      "build cannot run node to check the @aws/agentcore-cdk in agentcore/cdk. Put node on PATH, then build again.",
    ],
    [
      { accepts: false, reason: "timed-out" },
      "the check of the @aws/agentcore-cdk in agentcore/cdk took more than 60 seconds. Build again.",
    ],
    [
      { accepts: false, reason: "failed", detail: "the library is broken" },
      "the check of the @aws/agentcore-cdk in agentcore/cdk failed: the library is broken. Build again.",
    ],
  ] as const)(
    "stops, and keeps the target and agentcore.json, when the check gives %o",
    async (answer, why) => {
      const check: { current: PassthroughGatewayCheck } = { current: { accepts: true } };
      const { manager, root } = await strandsProject({ check });
      await addToolsGateway(root);
      await build(manager, root);
      const before = await text(root, SPEC);
      const profile = await text(root, RUNTIME_PROFILE);
      check.current = answer;

      await expect(build(manager, root)).rejects.toThrow(
        "Build stopped, and wrote nothing: build cannot tell if it can route the gateways 'tools' " +
          `of this project for a boxed agent, because ${why}`,
      );

      expect(await text(root, SPEC)).toBe(before);
      expect(await text(root, RUNTIME_PROFILE)).toBe(profile);
      expect(await targetNames(root)).toContain("egress-gateway-tools");
    },
  );

  test.each([
    [
      "only a CUSTOM_JWT gateway",
      {
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
            allowedAudience: ["agentcore"],
          },
        },
      },
      {},
    ],
    ["a PRIVATE_VPC runtime", {}, { containment: "PRIVATE_VPC" }],
  ])(
    "does not check the CDK library when no gateway gets a target: %s",
    async (_, gatewayFields, runtimeFields) => {
      let checks = 0;
      const check = {
        get current(): PassthroughGatewayCheck {
          checks++;
          return { accepts: true };
        },
      };
      const { manager, root } = await strandsProject({ check });
      await addToolsGateway(root);
      const spec = JSON.parse(await text(root, SPEC));
      Object.assign(
        spec.agentCoreGateways.find(({ name }: { name: string }) => name === "tools"),
        gatewayFields,
      );
      Object.assign(spec.runtimes[0], runtimeFields);
      await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));

      await build(manager, root);

      expect(checks).toBe(0);
      expect(await targetNames(root)).not.toContain("egress-gateway-tools");
    },
  );

  test("remove gateway keeps an egress- target that the user wrote on an ordinary gateway", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: true });
    await addToolsGateway(root);
    const spec = JSON.parse(await text(root, SPEC));
    spec.agentCoreGateways.push({
      name: "front",
      authorizerType: "AWS_IAM",
      protocolType: "None",
      targets: [
        {
          name: "egress-mine",
          targetType: "passthrough",
          passthrough: { gateway: "tools", protocolType: "CUSTOM" },
          outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore" },
        },
      ],
    });
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
    const before = await text(root, SPEC);
    const project = (await manager.resolve({ filePath: root })) as Project;

    // The target is the user's, so remove keeps it, and the schema refuses it with its name.
    await expect(
      manager.removeResource(project, { resourceType: "gateway", name: "tools" }),
    ).rejects.toThrow('Target "egress-mine" of gateway "front" names the gateway "tools"');
    expect(await text(root, SPEC)).toBe(before);
  });

  test("writes no target and no server, and warns once, when it does not", async () => {
    const { manager, root } = await strandsProject({ acceptsPassthroughGateway: false });
    await addToolsGateway(root);

    const { warnings } = await build(manager, root);

    expect(await targetNames(root)).not.toContain("egress-gateway-tools");
    expect((await runtimeProfile(root)).mcp).toBeUndefined();
    expect(warnings.filter((warning) => warning.includes("passthrough.gateway"))).toEqual([
      "The gateways 'tools' of this project get no route for a boxed agent on AgentCore " +
        "Runtime, because the @aws/agentcore-cdk in agentcore/cdk does not accept " +
        "passthrough.gateway. Update @aws/agentcore-cdk in agentcore/cdk/package.json to a " +
        "version that accepts it, then build again.",
    ]);
  });
});

describe("build sets box.version to the pinned box", () => {
  // The box features and the profiles that the CLI writes change together, so a project created
  // by an earlier CLI builds with the box this one ships, and agentcore.json says so.
  test("updates a runtime's older box.version, and says so", async () => {
    const { manager, root } = await strandsProject();
    const spec = JSON.parse(await text(root, SPEC));
    spec.runtimes[0].box = { version: "0.2.4" };
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));

    const { steps } = await build(manager, root);

    expect(steps).toContain(
      "updating box.version of runtime 'agent_python_strands' from 0.2.4 to " +
        `${BOX_RELEASE.version}, the box this CLI ships`,
    );
    expect(JSON.parse(await text(root, SPEC)).runtimes[0].box).toEqual({
      version: BOX_RELEASE.version,
    });
  });

  test("leaves the pinned box.version as it is, with no message", async () => {
    const { manager, root } = await strandsProject();
    const before = JSON.parse(await text(root, SPEC)).runtimes[0].box;

    const { steps } = await build(manager, root);

    expect(before).toEqual({ version: BOX_RELEASE.version });
    expect(steps.some((step) => step.startsWith("updating box.version"))).toBe(false);
    expect(JSON.parse(await text(root, SPEC)).runtimes[0].box).toEqual(before);
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
    Action: ["xray:PutSpans", "xray:PutTraceSegments"],
    Resource: "*",
  };
  const ADDED =
    `adding ${TELEMETRY_POLICY} to additionalPolicies of 'agent_python_strands', so its box can ` +
    "send telemetry to CloudWatch";

  /** {@link strandsProject} with OTEL off, so its Runtime profile gets no default X-Ray target. */
  async function otelOffProject(options?: Parameters<typeof strandsProject>[0]) {
    const created = await strandsProject(options);
    await setOtel(created.root, false);
    return created;
  }

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
      const { manager, root, box } = await otelOffProject();
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

  test("sets only additionalPolicies of the runtime, and keeps its other keys in their place", async () => {
    const { manager, root, box } = await otelOffProject();
    const spec = JSON.parse(await text(root, SPEC));
    spec.runtimes[0].myNote = "kept";
    await writeFile(path(root, SPEC), JSON.stringify(spec, undefined, 2));
    const keys = Object.keys(spec.runtimes[0]);
    box.answer = showsTelemetry({ logs: LOGS });

    await build(manager, root);

    const written = JSON.parse(await text(root, SPEC)).runtimes[0];
    expect(Object.keys(written)).toEqual([...keys, "additionalPolicies"]);
    expect(written.myNote).toBe("kept");
  });

  test("copies both CloudWatch targets into the Runtime profile, signed with the execution role", async () => {
    const { manager, root, box } = await otelOffProject();
    const records = { kind: "file", destination: "/tmp/records.jsonl" };
    box.answer = showsTelemetry({ logs: LOGS, traces: TRACES, records });

    await build(manager, root);

    // On the Runtime, a bare aws:// is the default credential chain: the execution role.
    expect((await runtimeProfile(root)).telemetry).toEqual({
      logs: { ...LOGS, secret: { ref: "aws://" } },
      traces: { ...TRACES, secret: { ref: "aws://" } },
    });
    expect(await text(root, RUNTIME_PROFILE)).not.toContain("my-profile");
  });

  test("changes nothing on a second build", async () => {
    const { manager, root, counter, box } = await otelOffProject();
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
    const { manager, root, box } = await otelOffProject();
    box.answer = showsTelemetry({ langfuse: { kind: "langfuse", secret: { ref: "env://KEY" } } });

    const { steps } = await build(manager, root);

    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
    expect((await runtimeEntry(root)).additionalPolicies).toBeUndefined();
    expect(steps.filter((step) => step.includes(TELEMETRY_POLICY))).toEqual([]);
  });

  test("removes the file and the entry when the profile no longer sends telemetry to CloudWatch", async () => {
    const { manager, root, box } = await otelOffProject();
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

    test("on build, sets the region build builds for, keeps a target's own region, and warns that dev needs a region", async () => {
      const { manager, root, box } = await otelOffProject({ env: { AWS_REGION: "eu-central-1" } });
      box.answer = showsTelemetry({
        logs: REGIONLESS_LOGS,
        traces: { ...TRACES, region: "eu-west-1" },
      });

      const { warnings } = await build(manager, root);

      expect((await runtimeProfile(root)).telemetry).toEqual({
        logs: logsIn("eu-central-1"),
        traces: { ...TRACES, region: "eu-west-1", secret: { ref: "aws://" } },
      });
      expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([
        statementIn("eu-central-1"),
        TRACES_STATEMENT,
      ]);
      expect(warnings).toContain(
        ".box/agent_python_strands/local/profile.toml: [telemetry.logs] has no region, so the AgentCore Runtime profile and " +
          "the telemetry policy get eu-central-1. Deploy sets the region of its deploy target. " +
          "Box refuses a CloudWatch target with no region, so `agentcore dev` cannot run this " +
          "profile until you add region to it.",
      );
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
      const { manager, root, box } = await otelOffProject({ backends: { CDK: backend } });
      box.answer = showsTelemetry({ logs: REGIONLESS_LOGS });
      await writeFile(
        path(root, "agentcore/aws-targets.json"),
        JSON.stringify([{ name: "primary", account: "111122223333", region: "ap-south-1" }]),
      );

      const project = (await manager.resolve({ filePath: root })) as Project;
      const { warnings } = await drain(
        manager.deploy(project, {
          target: "primary",
          region: "us-west-2",
          confirmTeardown: async () => false,
        }),
      );

      const [network] = calls[0]!.boxNetworks;
      expect(network?.runtimeProfile?.telemetry).toEqual({
        logs: logsIn("ap-south-1"),
      });
      expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([
        statementIn("ap-south-1"),
      ]);
      expect(warnings.filter((warning) => warning.includes("[telemetry.logs]"))).toEqual([
        expect.stringContaining("get ap-south-1."),
      ]);
    });
  });
});

describe("build with OTEL on, as create writes a box runtime", () => {
  const TELEMETRY_POLICY = "agentcore/box-telemetry-policy-agent_python_strands.json";
  const X_RAY = {
    Sid: "BoxTelemetryToXRay",
    Effect: "Allow",
    Action: ["xray:PutSpans", "xray:PutTraceSegments"],
    Resource: "*",
  };
  const DEFAULT_TRACES = {
    kind: "cloudwatch_traces",
    region: "${{ inputs.aws.region }}",
    include: ["deny", "permit", "trace"],
    secret: { ref: "aws://" },
  };
  const PACK = "app/agent_python_strands/.box-dist/resources/packs/agentcore/pack.toml";

  test("starts the agent under opentelemetry-instrument, sets up its ADOT SDK, and sends its spans to X-Ray with the grant", async () => {
    const { manager, root } = await strandsProject();
    expect(JSON.parse(await text(root, SPEC)).runtimes[0].instrumentation).toBeUndefined();

    const { warnings } = await build(manager, root);

    const profile = await runtimeProfile(root);
    expect((profile.agent as { command: string[] }).command.slice(0, 3)).toEqual([
      "${{ inputs.python.path }}",
      "${{ inputs.code.dir }}/bin/opentelemetry-instrument",
      "${{ inputs.python.path }}",
    ]);
    expect((profile.telemetry as Record<string, unknown>).agentcore_traces).toEqual(DEFAULT_TRACES);
    const pack = parse(await text(root, PACK)) as { agent: { env: Record<string, string> } };
    expect(pack.agent.env).toMatchObject({
      OTEL_PYTHON_DISTRO: "aws_distro",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_RESOURCE_ATTRIBUTES: "${{ inputs.runtime.resource_attributes }}",
    });
    expect(JSON.parse(await text(root, TELEMETRY_POLICY)).Statement).toEqual([X_RAY]);
    expect(JSON.parse(await text(root, SPEC)).runtimes[0].additionalPolicies).toEqual([
      "../../agentcore/box-telemetry-policy-agent_python_strands.json",
    ]);
    expect(warnings.filter((warning) => warning.includes("opentelemetry-instrument"))).toEqual([]);
  });

  test.each([
    ["enableOtel is false", (root: string) => setOtel(root, false)],
    ["the envVars set DISABLE_ADOT_OBSERVABILITY to true", (root: string) => optOut(root)],
  ])("adds nothing for OTEL when %s", async (_label, turnOff) => {
    const { manager, root } = await strandsProject();
    await turnOff(root);

    await build(manager, root);

    const profile = await runtimeProfile(root);
    expect(JSON.stringify(profile.agent)).not.toContain("opentelemetry-instrument");
    expect(profile.telemetry).not.toHaveProperty("agentcore_traces");
    const pack = parse(await text(root, PACK)) as { agent: { env: Record<string, string> } };
    expect(Object.keys(pack.agent.env)).toEqual(["MEMORY_AGENT_PYTHON_STRANDSMEMORY_ID"]);
    expect(existsSync(path(root, TELEMETRY_POLICY))).toBe(false);
  });

  test("changes nothing on a second build", async () => {
    const { manager, root, counter } = await strandsProject();
    await build(manager, root);
    const policy = await text(root, TELEMETRY_POLICY);
    const staged = await text(root, RUNTIME_PROFILE);
    counter.specWrites = 0;

    const { steps } = await build(manager, root);

    expect(steps).toEqual(["synthesizing CloudFormation templates"]);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, TELEMETRY_POLICY)).toBe(policy);
    expect(await text(root, RUNTIME_PROFILE)).toBe(staged);
  });
});

describe("build reads the box profile as box resolves it", () => {
  test("takes the route a pack adds, which the profile itself does not hold", async () => {
    const { manager, root, box } = await strandsProject({ env: { SEARCH_KEY: "key-1" } });
    const profile = await text(root, PROFILE);
    await writeFile(
      path(root, PROFILE),
      profile.replace('"@box/bedrock"]', '"@box/bedrock", "team/search"]'),
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
      "`box profile show .box/agent_python_strands/local/profile.toml --format json --full` failed in the project (exit code 1)",
    );
    const spec = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toBe(box.answer);
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
  });
});

describe("build writes the Bedrock target and the Memory route for the region it builds for", () => {});

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
  /**
   * The default target of the Runtime profile, as the box profile has no cloudwatch_logs target:
   * the runtime's own log group and log stream, which box reads when the run starts.
   */
  const DEFAULT_TARGET = {
    kind: "cloudwatch_logs",
    region: "${{ inputs.aws.region }}",
    log_group: "${{ inputs.runtime.log_group }}",
    log_stream: "${{ inputs.runtime.log_stream }}",
    include: ["deny", "permit", "trace"],
    secret: { ref: "aws://" },
  };

  /** {@link strandsProject} with OTEL off, so its Runtime profile gets no default X-Ray target. */
  async function otelOffProject(options?: Parameters<typeof strandsProject>[0]) {
    const created = await strandsProject(options);
    await setOtel(created.root, false);
    return created;
  }

  const showsTelemetry = (telemetry: Record<string, unknown>) => {
    const answer = shows();
    return { ...answer, boxToml: { ...answer.boxToml, telemetry } };
  };

  test("names the secret in the Runtime profile, and lets the execution role read it alone", async () => {
    const { manager, root, box } = await otelOffProject({
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
    expect(profile.plugins).toEqual(["@box/aws-secrets-manager"]);
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
    expect(spec.credentials ?? []).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("keeps today's Runtime profile with the switch off, and says why", async () => {
    const { manager, root, box } = await otelOffProject({
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
    const { manager, root, box } = await otelOffProject({ env: ON });
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
    expect(targets.find(({ name }) => name === "agentcore")).toBeUndefined();
    const profile = await runtimeProfile(root);
    expect(profile.options).toEqual({ bedrock: { region: "eu-central-1", "sign-in": "api-key" } });
    const egress = profile.egress as Record<string, { destinations: string[]; backends: unknown }>;
    expect(egress["bedrock-api-key"]!.destinations).toEqual([
      "bedrock-runtime.eu-central-1.amazonaws.com",
    ]);
    // The backend signs for the Runtime's own region, which box reads from AWS_REGION there.
    expect(JSON.stringify(egress["bedrock-api-key"]!.backends)).toContain(
      '"region":"${{ inputs.aws.region }}"',
    );
    // The Memory route goes to the Memory host of that region, with no backend.
    expect(egress.agentcore as unknown).toEqual({
      destinations: ["bedrock-agentcore.eu-central-1.amazonaws.com"],
      secret: { ref: "aws://" },
    });
  });

  test("takes the region build is given over AWS_REGION, as --region does", async () => {
    const { manager, root } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
    const project = (await manager.resolve({ filePath: root })) as Project;

    await drain(manager.build(project, { region: "ap-northeast-1" }));

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("ap-northeast-1"));
    expect((await runtimeProfile(root)).options).toEqual({
      bedrock: { region: "ap-northeast-1", "sign-in": "api-key" },
    });
  });

  test("has box resolve the profile for that region, from a copy it then removes", async () => {
    // create wrote the profile for us-west-2, the region `agentcore dev` calls Bedrock in.
    const { manager, root, box } = await strandsProject({ env: { AWS_REGION: "eu-central-1" } });
    const before = await boxFiles(root);

    await build(manager, root);

    // @box/bedrock's route is for eu-central-1, so the bedrock target serves it, and no
    // egress-bedrock target is added for the us-west-2 host that `agentcore dev` calls.
    expect(await targetNames(root)).toEqual(["bedrock"]);
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

  test("moves a target it wrote for another region", async () => {
    const { manager, root } = await strandsProject();
    await build(manager, root);
    await editGateway(root, (gateway) => {
      gateway.targets = gateway.targets.map((target) =>
        (target as { name: string }).name === "bedrock" ? bedrockTarget("us-east-1") : target,
      );
    });

    const { steps } = await build(manager, root);

    const { targets } = await boxGateway(root);
    expect(targets.find(({ name }) => name === "bedrock")).toEqual(bedrockTarget("us-west-2"));
    expect(steps).toContain(
      `updating target 'bedrock' of gateway '${GATEWAY}' in agentcore.json from us-east-1 to us-west-2`,
    );
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
    expect(gateway?.targets.map(({ name }) => name)).toEqual(["egress-github", "bedrock"]);
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

  test("moves the Bedrock policy with its target, and the Memory route, to the region of the targets", async () => {
    // The networks build and deploy hand the backend, which this one does not stage.
    const networks: (readonly BoxNetwork[])[] = [];
    const backend: ProjectBackend = {
      async *build(_project, input) {
        networks.push(input?.boxNetworks ?? []);
        yield { type: "step", message: "building" };
      },
      async *deploy(_project, input) {
        networks.push(input.boxNetworks);
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
    const memoryRoute = () =>
      (networks.at(-1)![0]!.runtimeProfile!.egress as Record<string, unknown>).agentcore;
    const bedrockResources = async () =>
      JSON.parse(await text(root, "agentcore/box-bedrock-policy.json")).Statement.map(
        ({ Resource }: { Resource: string[] }) => Resource,
      );
    const authOf = async (target: string) =>
      (await boxGateway(root)).targets.find(({ name }) => name === target)?.outboundAuth;
    const routeFor = (region: string) => ({
      destinations: [`bedrock-agentcore.${region}.amazonaws.com`],
      secret: { ref: "aws://" },
    });
    const bedrockFor = (region: string) => [
      [`arn:aws:bedrock:${region}:*:inference-profile/*`],
      [`arn:aws:bedrock:${region}::foundation-model/*`],
      ["arn:aws:bedrock:*::foundation-model/*"],
    ];
    await build(manager, root);
    expect(await authOf("agentcore")).toBeUndefined();
    expect(await authOf("bedrock")).toMatchObject({ region: "us-west-2" });
    expect(existsSync(path(root, "agentcore/box-memory-policy.json"))).toBe(false);
    expect(memoryRoute()).toEqual(routeFor("us-west-2"));
    expect(await bedrockResources()).toEqual(bedrockFor("us-west-2"));
    await writeFile(
      path(root, "agentcore/aws-targets.json"),
      JSON.stringify([{ name: "primary", account: "111122223333", region: "eu-west-1" }]),
    );

    const project = (await manager.resolve({ filePath: root })) as Project;
    await drain(
      manager.deploy(project, {
        target: "primary",
        region: "us-west-2",
        confirmTeardown: async () => false,
      }),
    );

    expect(await authOf("bedrock")).toMatchObject({ region: "eu-west-1" });
    expect(memoryRoute()).toEqual(routeFor("eu-west-1"));
    expect(await bedrockResources()).toEqual(bedrockFor("eu-west-1"));
  });
});
