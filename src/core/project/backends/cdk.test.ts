import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import { CdkBackend } from "./cdk";
import type { CredentialProvisionInput, DeployedCredentials } from "./cdk/credentials";
import type { BootstrapState } from "./cdk/environment";
import type { CdkCredentialProvider, CdkOperation, CdkOutputs, CdkRunOptions } from "./cdk/toolkit";

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "us-east-1",
} as const;

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function cdkDirectory(project: Project): string {
  return join(project.rootPath, "agentcore", "cdk");
}

function assemblyDirectory(project: Project): string {
  return join(cdkDirectory(project), "cdk.out");
}

function synthCommand(project: Project): string[] {
  return ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", assemblyDirectory(project)];
}

async function project(withDependencies = true): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-cdk-backend-"));
  tempDirectories.push(rootPath);
  const cdkDir = join(rootPath, "agentcore", "cdk");
  await mkdir(withDependencies ? join(cdkDir, "node_modules") : cdkDir, {
    recursive: true,
  });
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "example", version: 1 }),
  };
}

type AssemblyOptions = {
  /** Overrides the environment every stack artifact is synthesized for. */
  environment?: string;
  /** Overrides the resources every stack's template declares. */
  resources?: Record<string, unknown>;
};

async function writeAssembly(
  project: Project,
  targetNames: string[],
  options: AssemblyOptions = {},
): Promise<void> {
  const directory = assemblyDirectory(project);
  await mkdir(directory, { recursive: true });
  const stacks = targetNames.map((target, index) => ({
    target,
    id: `AgentCore-example-${target}-${index}`,
    templateFile: `AgentCore-example-${target}-${index}.template.json`,
  }));

  await Promise.all(
    stacks.map((stack) =>
      writeFile(
        join(directory, stack.templateFile),
        JSON.stringify({
          Resources: options.resources ?? { Runtime: { Type: "AWS::BedrockAgentCore::Runtime" } },
        }),
      ),
    ),
  );

  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: "36.0.0",
      artifacts: {
        Tree: { type: "cdk:tree" },
        ...Object.fromEntries(
          stacks.map((stack) => [
            stack.id,
            {
              type: "aws:cloudformation:stack",
              environment: options.environment ?? `aws://${TARGET.account}/${TARGET.region}`,
              properties: {
                templateFile: stack.templateFile,
                tags: { "agentcore:target-name": stack.target },
              },
            },
          ]),
        ),
      },
    }),
  );
}

type HarnessOptions = {
  account?: string;
  bootstrap?: BootstrapState;
  outputs?: CdkOutputs;
  template?: boolean;
  failOperation?: CdkOperation["kind"];
  bootstrapError?: Error;
  provisioned?: DeployedCredentials;
  provisionError?: Error;
};

function harness(options: HarnessOptions = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  const provisionInputs: CredentialProvisionInput[] = [];
  // The state file as the synth step sees it, which is the contract deploy owes
  // the synthesized app: credential ARNs on disk before templates are built.
  const stateAtSynth: (string | null)[] = [];
  const runs: { operation: CdkOperation; options: CdkRunOptions }[] = [];
  const credentialRegions: string[] = [];
  const accountCredentials: CdkCredentialProvider[] = [];
  const bootstrapCredentials: CdkCredentialProvider[] = [];
  const accountRegions: string[] = [];
  const bootstrapRegions: string[] = [];
  let templateLoads = 0;
  let templateCleanups = 0;
  const credentials: CdkCredentialProvider = async () => ({
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
  });

  const backend = new CdkBackend({
    logger: createSilentLogger(),
    runner: async (command, { cwd }) => {
      commands.push({ command, cwd });
      const state = join(cwd, "..", ".cli", "deployed-state.json");
      stateAtSynth.push(existsSync(state) ? await Bun.file(state).text() : null);
    },
    checkTool: async () => {},
    resolveCredentials: async (region) => {
      credentialRegions.push(region);
      return credentials;
    },
    resolveAccount: async (region, provider) => {
      accountRegions.push(region);
      accountCredentials.push(provider);
      return options.account ?? TARGET.account;
    },
    bootstrap: async (region, provider) => {
      bootstrapRegions.push(region);
      bootstrapCredentials.push(provider);
      if (options.bootstrapError) throw options.bootstrapError;
      return options.bootstrap ?? { kind: "current", version: 30 };
    },
    cdk: async (operation, runOptions) => {
      runs.push({ operation, options: runOptions });
      if (operation.kind === options.failOperation) {
        throw new Error(`${operation.kind} failed`);
      }
      return operation.kind === "deploy" ? (options.outputs ?? {}) : {};
    },
    provisionCredentials: async function* (_project, input) {
      provisionInputs.push(input);
      if (options.provisionError) throw options.provisionError;
      for (const name of Object.keys(options.provisioned ?? {})) {
        yield { message: `Preparing credential provider '${name}'` };
      }
      return options.provisioned ?? {};
    },
    loadBootstrapTemplate: async () => {
      templateLoads++;
      if (!options.template) return undefined;
      return {
        path: "/tmp/bootstrap-template.yaml",
        cleanup: async () => {
          templateCleanups++;
        },
      };
    },
  });

  return {
    accountCredentials,
    accountRegions,
    backend,
    bootstrapCredentials,
    bootstrapRegions,
    commands,
    credentialRegions,
    credentials,
    provisionInputs,
    runs,
    stateAtSynth,
    templateLoads: () => templateLoads,
    templateCleanups: () => templateCleanups,
  };
}

async function collect(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

async function collectDeploy(
  generator: AsyncGenerator<ProjectEvent, DeployResult>,
): Promise<{ events: ProjectEvent[]; result: DeployResult }> {
  const events: ProjectEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value as ProjectEvent);
  }
}

describe("CdkBackend.build", () => {
  test("synthesizes into the assembly directory deploy reads", async () => {
    const input = await project();
    const subject = harness();

    expect(await collect(subject.backend.build(input))).toEqual([
      { message: "Synthesizing CloudFormation templates" },
    ]);
    expect(subject.commands).toEqual([{ command: synthCommand(input), cwd: cdkDirectory(input) }]);
  });

  test("fails actionably when CDK dependencies are missing", async () => {
    const input = await project(false);
    const subject = harness();

    await expect(collect(subject.backend.build(input))).rejects.toThrow(/npm install/);
    expect(subject.commands).toEqual([]);
  });

  test("propagates synthesis failures", async () => {
    const input = await project();
    const subject = new CdkBackend({
      logger: createSilentLogger(),
      runner: async () => {
        throw new Error("cdk synth exploded");
      },
      checkTool: async () => {},
    });

    await expect(collect(subject.build(input))).rejects.toThrow("cdk synth exploded");
  });
});

describe("CdkBackend.deploy", () => {
  test("preflights, synthesizes, and deploys the selected stack", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" } });

    const deployed = await collectDeploy(subject.backend.deploy(input, { target: TARGET }));

    expect(deployed.events).toEqual([
      { message: `Verifying AWS account ${TARGET.account}` },
      { message: "Synthesizing CloudFormation templates" },
      { message: "Deploying AgentCore-example-default-0" },
    ]);
    expect(deployed.result).toEqual({ outputs: { RuntimeArn: "arn:runtime" } });
    expect(subject.commands).toEqual([{ command: synthCommand(input), cwd: cdkDirectory(input) }]);
    expect(subject.runs).toEqual([
      {
        operation: {
          kind: "deploy",
          stackArtifactId: "AgentCore-example-default-0",
        },
        options: {
          assemblyDirectory: assemblyDirectory(input),
          credentials: subject.credentials,
          region: TARGET.region,
        },
      },
    ]);
    expect(subject.provisionInputs).toEqual([
      { credentials: subject.credentials, region: TARGET.region },
    ]);
    expect(subject.credentialRegions).toEqual([TARGET.region]);
    expect(subject.accountCredentials).toEqual([subject.credentials]);
    expect(subject.bootstrapCredentials).toEqual([subject.credentials]);
    expect(subject.accountRegions).toEqual([TARGET.region]);
    expect(subject.bootstrapRegions).toEqual([TARGET.region]);
    expect(subject.templateLoads()).toBe(0);
  });

  test("refuses a resource-less stack before the Toolkit can delete it", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: {} });
    const subject = harness();

    await expect(
      collectDeploy(subject.backend.deploy(input, { target: TARGET })),
    ).rejects.toThrow(/declares no resources/);
    // Nothing reached the Toolkit, so no stack was deleted and none bootstrapped.
    expect(subject.runs).toEqual([]);
    expect(subject.bootstrapRegions).toEqual([]);
  });

  test("refuses a stack synthesized for a different region than the target", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], {
      environment: `aws://${TARGET.account}/us-west-2`,
    });
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      /built for region us-west-2 \(target expects us-east-1\)/,
    );
    expect(subject.runs).toEqual([]);
  });

  test.each([
    ["absent", { kind: "absent" } as const],
    ["outdated", { kind: "outdated", version: 29 } as const],
  ])("bootstraps an %s environment before deploying", async (_label, bootstrap) => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ bootstrap });

    const deployed = await collectDeploy(subject.backend.deploy(input, { target: TARGET }));

    expect(subject.runs.map(({ operation }) => operation)).toEqual([
      {
        kind: "bootstrap",
        environments: [`aws://${TARGET.account}/${TARGET.region}`],
      },
      { kind: "deploy", stackArtifactId: "AgentCore-example-default-0" },
    ]);
    expect(deployed.events).toContainEqual({
      message: `Bootstrapping aws://${TARGET.account}/${TARGET.region}`,
    });
  });

  test("records provisioned credential ARNs before synthesizing", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const provisioned = { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };
    const subject = harness({ provisioned });

    const deployed = await collectDeploy(subject.backend.deploy(input, { target: TARGET }));

    expect(deployed.events).toEqual([
      { message: `Verifying AWS account ${TARGET.account}` },
      { message: "Preparing credential provider 'openai-key'" },
      { message: "Synthesizing CloudFormation templates" },
      { message: "Deploying AgentCore-example-default-0" },
    ]);
    expect(subject.stateAtSynth.map((state) => state && JSON.parse(state))).toEqual([
      { targets: { default: { resources: { credentials: provisioned } } } },
    ]);
  });

  test("leaves no state file for a project that declares no credentials", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness();

    await collectDeploy(subject.backend.deploy(input, { target: TARGET }));

    expect(subject.stateAtSynth).toEqual([null]);
  });

  test("does not synthesize when credential provisioning fails", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ provisionError: new Error("no secret for 'openai-key'") });

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      "no secret for 'openai-key'",
    );
    expect(subject.commands).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("rejects credentials for a different account before build or mutation", async () => {
    const input = await project();
    const subject = harness({ account: "999900001111" });

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      /expects AWS account 111122223333.*999900001111/,
    );
    expect(subject.commands).toEqual([]);
    expect(subject.bootstrapRegions).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("does not touch bootstrap or deploy when the assembly lacks the target", async () => {
    const input = await project();
    await writeAssembly(input, ["other"]);
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      /no stack for deployment target 'default'/,
    );
    expect(subject.bootstrapRegions).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("rejects an ambiguous assembly before touching bootstrap or deploy", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name, TARGET.name]);
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      /2 stacks for deployment target 'default'/,
    );
    expect(subject.bootstrapRegions).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("propagates an unsafe bootstrap state without running the Toolkit", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const failure = new Error("CDKToolkit is UPDATE_IN_PROGRESS");
    const subject = harness({ bootstrapError: failure });

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toBe(
      failure,
    );
    expect(subject.runs).toEqual([]);
  });

  test("uses and cleans up an embedded bootstrap template", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ bootstrap: { kind: "absent" }, template: true });

    await collectDeploy(subject.backend.deploy(input, { target: TARGET }));

    expect(subject.runs[0]?.operation).toEqual({
      kind: "bootstrap",
      environments: [`aws://${TARGET.account}/${TARGET.region}`],
      templateFile: "/tmp/bootstrap-template.yaml",
    });
    expect(subject.templateLoads()).toBe(1);
    expect(subject.templateCleanups()).toBe(1);
  });

  test("cleans up the embedded template when bootstrap fails", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({
      bootstrap: { kind: "absent" },
      template: true,
      failOperation: "bootstrap",
    });

    await expect(collectDeploy(subject.backend.deploy(input, { target: TARGET }))).rejects.toThrow(
      "bootstrap failed",
    );
    expect(subject.templateCleanups()).toBe(1);
    expect(subject.runs.map(({ operation }) => operation.kind)).toEqual(["bootstrap"]);
  });
});
