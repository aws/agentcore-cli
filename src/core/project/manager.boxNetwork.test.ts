import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { InputValidationError } from "../../errors/errors";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { Project } from "../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import type { DeployBackendInput, ProjectBackend } from "./backends/types";
import { FsProjectManager } from "./manager";

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
const GITHUB_KEY = {
  type: "API_KEY",
  credentialName: "github",
  location: "HEADER",
  parameterName: "Authorization",
  prefix: "Bearer",
};
const GATEWAY_BACKEND = (target: string) => [
  {
    url: `@GATEWAY_BOX_URL@/${target}`,
    auth: { ref: "aws://", aws: { service: "bedrock-agentcore", region: "us-west-2" } },
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

/** A staging-boxy checkout with stand-in binaries, which staging copies into the zip. */
async function boxSource(): Promise<string> {
  const source = await temporary("agentcore-box-source-");
  await mkdir(join(source, "target-al2023", "release"), { recursive: true });
  for (const binary of ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"]) {
    await writeFile(join(source, "target-al2023", "release", binary), `#!${binary}\n`);
  }
  await mkdir(join(source, "resources"), { recursive: true });
  return source;
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
  const manager = new FsProjectManager({
    logger: createSilentLogger(),
    identity: new TestIdentityClient(),
    enableTransactionSearch: async () => {},
    runner: async () => {},
    checkTool: async () => {},
    json,
    processEnv: { AGENTCORE_BOX_SOURCE: await boxSource(), ...options.env },
    ...(options.backends && { backends: options.backends }),
  });
  const { value: created } = await drain(
    manager.create({
      name: "demo",
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands"),
      skipInstall: true,
      skipGit: true,
    }),
  );
  const root = created.rootPath;
  await mkdir(join(root, "agentcore", "cdk", "node_modules"), { recursive: true });
  counter.specWrites = 0;
  return { manager, root, counter };
}

const path = (root: string, relative: string) => join(root, ...relative.split("/"));
const text = (root: string, relative: string) => readFile(path(root, relative), "utf8");

/** Adds `tables` to the end of the profile, `top` to its start, and writes `.box/policy.dw`. */
async function editProfile(root: string, edit: { top?: string; tables?: string; policy?: string }) {
  const profile = await text(root, ".box/profile.toml");
  await writeFile(
    path(root, ".box/profile.toml"),
    `${edit.top ?? ""}${profile}${edit.tables ?? ""}`,
  );
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
    const { manager, root, counter } = await strandsProject();
    await editProfile(root, {
      top: 'policies = ["policy.dw"]\n',
      tables: GITHUB_ROUTE,
      policy: POLICY,
    });
    const before = await boxFiles(root);

    const { steps } = await build(manager, root);

    expect(counter.specWrites).toBe(1);
    expect(await targetNames(root)).toEqual([
      "bedrock",
      "egress-github",
      "egress-httpbin-org",
      "agentcore",
    ]);
    const { targets } = await boxGateway(root);
    expect(targets[1]).toEqual(
      userTarget("egress-github", "https://api.github.com", { outboundAuth: GITHUB_KEY }),
    );
    expect(targets[2]).toEqual(userTarget("egress-httpbin-org", "https://httpbin.org"));
    expect(steps).toContain(
      `adding target 'egress-github' to gateway '${GATEWAY}' in agentcore.json, for api.github.com`,
    );

    // The Runtime profile routes each target of the Box gateway, as upstream renders it.
    const profile = await runtimeProfile(root);
    expect(profile.policies).toEqual(["policy.dw"]);
    expect(await text(root, "app/agent_python_strands/.box-dist/policy.dw")).toBe(POLICY);
    const egress = profile.egress as Record<string, unknown>;
    expect(Object.keys(egress)).toEqual([
      "bedrock",
      "egress-github",
      "egress-httpbin-org",
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

  test("changes nothing on a second build", async () => {
    const { manager, root, counter } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
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
    const { manager, root } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    await editGateway(root, (gateway) => {
      gateway.targets.push(
        userTarget("gh", "https://api.github.com:443", { outboundAuth: GITHUB_KEY }),
        userTarget("weather", "https://weather.example.com"),
      );
    });

    await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "gh", "weather", "agentcore"]);
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(egress.gh).toMatchObject({ destinations: ["api.github.com"] });
  });

  test("removes a target it added when the profile no longer allows its host, and only that one", async () => {
    const { manager, root } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    await build(manager, root);
    const profile = await text(root, ".box/profile.toml");
    await writeFile(path(root, ".box/profile.toml"), profile.replace(GITHUB_ROUTE, ""));

    const { steps } = await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    expect(steps).toContain(
      `removing target 'egress-github' from gateway '${GATEWAY}' in agentcore.json: Box allows ` +
        "no request to its host in .box/profile.toml",
    );
  });

  test("gives the Memory endpoint to the agentcore target, and adds no second target for it", async () => {
    const { manager, root } = await strandsProject();
    await editProfile(root, {
      tables:
        '\n[egress.memory]\ndestinations = ["bedrock-agentcore.us-west-2.amazonaws.com"]\n' +
        'secret.ref = "aws://default"\n',
    });

    await build(manager, root);

    expect(await targetNames(root)).toEqual(["bedrock", "agentcore"]);
    const egress = (await runtimeProfile(root)).egress as Record<string, unknown>;
    expect(Object.keys(egress)).toEqual(["bedrock", "agentcore"]);
  });

  test("on a first build, stops with every failure, where it is, and writes nothing", async () => {
    const { manager, root, counter } = await strandsProject();
    await editProfile(root, {
      top: 'policies = ["policy.dw"]\n',
      tables:
        GITHUB_ROUTE +
        '\n[egress.signed]\ndestinations = ["api.example.com"]\nsecret.ref = "aws://default"\n',
      policy:
        "// Every subdomain of example.com.\n" +
        `@id("wild") permit (principal, ${HR}, resource) when { context.input.host like "*.example.com" };\n`,
    });
    const spec = await text(root, SPEC);
    const envLocal = await text(root, "agentcore/.env.local");
    const before = await boxFiles(root);

    const error = await build(manager, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toBe(
      ".box/profile.toml does not parse into the Box network of the Box gateway " +
        `'${GATEWAY}' of runtime 'agent_python_strands' (2 failures):\n` +
        '  - WILDCARD_HOST, rule "wild", at .box/policy.dw:2:1: it allows hosts by the pattern ' +
        'context.input.host like "*.example.com"; a gateway target needs one fixed host, so ' +
        "name each host\n" +
        "  - UNSIGNABLE_HOST, [egress.signed]: it signs api.example.com with aws://default, but " +
        "the host is not an AWS endpoint the gateway can sign for: bedrock, bedrock-runtime, " +
        "bedrock-agentcore, or a Lambda function URL\n\n" +
        "Nothing of the box profile was written: no gateway target, credential, Memory target, " +
        "or file. Change the profile or its policy files, then retry.",
    );
    expect(counter.specWrites).toBe(0);
    expect(await text(root, SPEC)).toBe(spec);
    expect(existsSync(path(root, "agentcore/box-memory-policy.json"))).toBe(false);
    expect(await text(root, "agentcore/.env.local")).toBe(envLocal);
    expect(existsSync(path(root, RUNTIME_PROFILE))).toBe(false);
    expect(await boxFiles(root)).toEqual(before);
  });

  test("refuses a target of the user's whose outbound auth differs from the entry's", async () => {
    const { manager, root } = await strandsProject();
    await editProfile(root, { tables: GITHUB_ROUTE });
    await editGateway(root, (gateway) => {
      gateway.targets.push(userTarget("gh", "https://api.github.com"));
    });
    const spec = await text(root, SPEC);

    await expect(build(manager, root)).rejects.toThrow(
      "EXISTING_TARGET_CONFLICT, [egress.github]: the Box gateway's target gh sends NONE to " +
        "api.github.com",
    );
    expect(await text(root, SPEC)).toBe(spec);
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
    const { manager, root } = await strandsProject({
      backends: { CDK: backend },
      env: { GITHUB_TOKEN: "ghp_123" },
    });
    await writeFile(
      path(root, "agentcore/aws-targets.json"),
      JSON.stringify([{ name: "primary", account: "111122223333", region: "us-west-2" }]),
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
      "bedrock",
      "egress-github",
      "agentcore",
    ]);
    expect(spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });
    expect(calls[0]!.input.boxNetworks.map(({ gateway: name }) => name)).toEqual([GATEWAY]);
    expect(await text(root, "agentcore/.env.local")).toMatch(/^AGENTCORE_CREDENTIAL_GITHUB=./m);
  });
});
