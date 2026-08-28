import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import { CdkBackend } from "./cdk";
import type { CredentialProvisioner } from "./cdk/credentials";
import { DEPLOYED_STATE_RELATIVE_PATH } from "./cdk/deployedState";
import type { DeployBackendInput } from "./types";
import type { BootstrapState } from "./cdk/environment";
import type { CdkCredentialProvider, CdkOperation, CdkOutputs, CdkRunOptions } from "./cdk/toolkit";

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "us-east-1",
} as const;

/** A template holding only what CDK adds itself, as an empty project synthesizes. */
const METADATA_ONLY = { CDKMetadata: { Type: "AWS::CDK::Metadata" } };

function deployInput(overrides: Partial<DeployBackendInput> = {}): DeployBackendInput {
  return { target: TARGET, confirmTeardown: async () => false, ...overrides };
}

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
  stackArn?: string;
  omitStackArn?: boolean;
  template?: boolean;
  failOperation?: CdkOperation["kind"];
  bootstrapError?: Error;
  provisionCredentials?: CredentialProvisioner;
  /** Whether CloudFormation still holds the target's stack. Defaults to present. */
  stackExists?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  const runs: { operation: CdkOperation; options: CdkRunOptions }[] = [];
  const credentialRegions: string[] = [];
  const accountCredentials: CdkCredentialProvider[] = [];
  const bootstrapCredentials: CdkCredentialProvider[] = [];
  const accountRegions: string[] = [];
  const bootstrapRegions: string[] = [];
  const stackProbes: string[] = [];
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
    stack: async (stackName) => {
      stackProbes.push(stackName);
      return options.stackExists ?? true;
    },
    cdk: async (operation, runOptions) => {
      runs.push({ operation, options: runOptions });
      if (operation.kind === options.failOperation) {
        throw new Error(`${operation.kind} failed`);
      }
      if (operation.kind !== "deploy") return { outputs: {} };
      return {
        outputs: options.outputs ?? {},
        // A real deploy always carries a stack ARN; default one so tests exercise
        // the persistence path, and use `omitStackArn` to test its absence.
        ...(options.omitStackArn
          ? {}
          : {
              stackArn:
                options.stackArn ??
                "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/deployed",
            }),
      };
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
    ...(options.provisionCredentials && { provisionCredentials: options.provisionCredentials }),
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
    runs,
    stackProbes,
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

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

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
    expect(subject.credentialRegions).toEqual([TARGET.region]);
    expect(subject.accountCredentials).toEqual([subject.credentials]);
    expect(subject.bootstrapCredentials).toEqual([subject.credentials]);
    expect(subject.accountRegions).toEqual([TARGET.region]);
    expect(subject.bootstrapRegions).toEqual([TARGET.region]);
    expect(subject.templateLoads()).toBe(0);
  });

  test("persists the deployed stack ARN under the target", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({
      outputs: { RuntimeArn: "arn:runtime" },
      stackArn: "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
    });

    await collectDeploy(subject.backend.deploy(input, deployInput()));

    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    expect(JSON.parse(await Bun.file(statePath).text())).toEqual({
      targets: {
        default: {
          resources: { credentials: {} },
          stackArn:
            "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
        },
      },
    });
  });

  test("provisions credentials before synth and records them under the target", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const provisionCredentials: CredentialProvisioner = async function* () {
      yield { message: "Preparing credential provider 'openai-key'" };
      return { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };
    };
    const subject = harness({
      outputs: { RuntimeArn: "arn:runtime" },
      stackArn: "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
      provisionCredentials,
    });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    // The credential step runs (and its ARNs are recorded) before synthesis, so
    // the assembly is synthesized against a state file that already describes them.
    const messages = deployed.events.map((event) => event.message);
    expect(messages.indexOf("Preparing credential provider 'openai-key'")).toBeLessThan(
      messages.indexOf("Synthesizing CloudFormation templates"),
    );

    // The pre-synth credentials write and the post-deploy stack-ARN write merge
    // into one target entry rather than clobbering each other.
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    expect(JSON.parse(await Bun.file(statePath).text())).toEqual({
      targets: {
        default: {
          stackArn:
            "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
          resources: {
            credentials: { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } },
          },
        },
      },
    });
  });

  test("fails a deploy whose result carries no stack ARN, recording no binding", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" }, omitStackArn: true });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /without a stack ARN/,
    );
    // The pre-synth credentials write may have created the file, but the failed
    // deploy must not have recorded a stack binding.
    const state = JSON.parse(
      await Bun.file(join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH)).text(),
    );
    expect(state.targets.default?.stackArn).toBeUndefined();
  });

  test("checks local CDK prerequisites before provisioning credentials", async () => {
    const input = await project(false); // no agentcore/cdk/node_modules
    let provisioned = false;
    // eslint-disable-next-line require-yield -- a spy that should never run (deploy fails first)
    const provisionCredentials: CredentialProvisioner = async function* () {
      provisioned = true;
      return {};
    };
    const subject = harness({ provisionCredentials });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /npm install/,
    );
    expect(provisioned).toBe(false);
  });

  test("fails before touching AWS when the existing state file is malformed", async () => {
    const input = await project();
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{ not valid json");
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" } });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow();
    // Validated before synth/bootstrap/deploy, so nothing ran against AWS.
    expect(subject.commands).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("will not remove a stack the user did not ask to remove", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: {} });
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /would delete stack 'AgentCore-example-default-0'.*--yes/s,
    );
    // Nothing reached the Toolkit, so no stack was deleted and none bootstrapped.
    expect(subject.runs).toEqual([]);
    expect(subject.bootstrapRegions).toEqual([]);
  });

  test("requests confirmation with the exact teardown details", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const requests: unknown[] = [];
    const subject = harness();

    await expect(
      collectDeploy(
        subject.backend.deploy(
          input,
          deployInput({
            confirmTeardown: async (request) => {
              requests.push(request);
              return false;
            },
          }),
        ),
      ),
    ).rejects.toThrow(/--yes/);

    expect(requests).toEqual([
      {
        projectName: "example",
        targetName: "default",
        resourceDescription: "stack 'AgentCore-example-default-0' and every resource in it",
        account: TARGET.account,
        region: TARGET.region,
      },
    ]);
    expect(subject.runs).toEqual([]);
  });

  test("treats a template holding only CDK's own metadata as nothing to deploy", async () => {
    // An empty project still synthesizes this one resource, so a check for an
    // empty Resources block would let the teardown case through as a deploy.
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /--yes/,
    );
    expect(subject.runs).toEqual([]);
  });

  test("removes the stack when the teardown is confirmed", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        targets: {
          default: { stackArn: "arn:stack:default" },
          prod: { stackArn: "arn:stack:prod" },
        },
      }),
    );
    const subject = harness();
    const deployed = await collectDeploy(
      subject.backend.deploy(
        input,
        deployInput({
          confirmTeardown: async () => true,
        }),
      ),
    );

    expect(deployed.result).toEqual({ outputs: {}, tornDown: true });
    expect(deployed.events).toContainEqual({
      message: "Removing stack AgentCore-example-default-0",
    });
    // Destroyed explicitly, rather than by deploying an empty template and
    // letting the Toolkit infer a deletion.
    expect(subject.runs.map(({ operation }) => operation)).toEqual([
      { kind: "destroy", stackArtifactId: "AgentCore-example-default-0" },
    ]);
    expect(subject.stackProbes).toEqual(["AgentCore-example-default-0"]);
    expect(JSON.parse(await Bun.file(statePath).text())).toEqual({
      targets: { prod: { stackArn: "arn:stack:prod" } },
    });
  });

  test("says to add a resource when there is no stack to remove either", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const subject = harness({ stackExists: false });

    await expect(
      collectDeploy(
        subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
      ),
    ).rejects.toThrow(/no stack .* exists .* to remove.*Add a resource/s);
    expect(subject.runs).toEqual([]);
  });

  test("does not probe for a stack when there is something to deploy", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness();

    await collectDeploy(subject.backend.deploy(input, deployInput()));

    expect(subject.stackProbes).toEqual([]);
  });

  test.each([
    ["absent", { kind: "absent" } as const],
    ["outdated", { kind: "outdated", version: 29 } as const],
  ])("bootstraps an %s environment before deploying", async (_label, bootstrap) => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ bootstrap });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

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

  test("rejects credentials for a different account before build or mutation", async () => {
    const input = await project();
    const subject = harness({ account: "999900001111" });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
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

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /no stack for deployment target 'default'/,
    );
    expect(subject.bootstrapRegions).toEqual([]);
    expect(subject.runs).toEqual([]);
  });

  test("rejects an ambiguous assembly before touching bootstrap or deploy", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name, TARGET.name]);
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
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

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toBe(failure);
    expect(subject.runs).toEqual([]);
  });

  test("uses and cleans up an embedded bootstrap template", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ bootstrap: { kind: "absent" }, template: true });

    await collectDeploy(subject.backend.deploy(input, deployInput()));

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

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      "bootstrap failed",
    );
    expect(subject.templateCleanups()).toBe(1);
    expect(subject.runs.map(({ operation }) => operation.kind)).toEqual(["bootstrap"]);
  });
});
