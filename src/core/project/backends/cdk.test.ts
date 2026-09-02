import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Stack } from "@aws-sdk/client-cloudformation";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import { CdkBackend } from "./cdk";
import type {
  CredentialProviderCalls,
  CredentialProvisioner,
  DeployedCredentials,
  PaymentCredentialRemover,
} from "./cdk/credentials";
import { DEPLOYED_STATE_RELATIVE_PATH, updateTargetState } from "./cdk/deployedState";
import type { DeployBackendInput } from "./types";
import type { ResolvedProjectResource } from "../../../handlers/project/types";
import type { BootstrapState } from "./cdk/environment";
import type { CdkCredentialProvider, CdkOperation, CdkOutputs, CdkRunOptions } from "./cdk/toolkit";

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "us-east-1",
} as const;
const STACK_ARN =
  "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc";
const json = new FsReadWriteJson({ logger: createSilentLogger() });

/** A template holding only what CDK adds itself, as an empty project synthesizes. */
const METADATA_ONLY = { CDKMetadata: { Type: "AWS::CDK::Metadata" } };

/**
 * Identity for backends whose provisioning is not under test: these projects declare
 * no credentials, and the tests that do exercise provisioning inject their own
 * CredentialProvisioner. Any call here is a test that stopped meaning what it says.
 */
function unusedIdentity(): CredentialProviderCalls {
  const unexpected = (call: string) => async (): Promise<never> => {
    throw new Error(`unexpected Identity call: ${call}`);
  };
  return {
    getApiKeyCredentialProvider: unexpected("getApiKeyCredentialProvider"),
    createApiKeyCredentialProvider: unexpected("createApiKeyCredentialProvider"),
    updateApiKeyCredentialProvider: unexpected("updateApiKeyCredentialProvider"),
    getOauth2CredentialProvider: unexpected("getOauth2CredentialProvider"),
    createOauth2CredentialProvider: unexpected("createOauth2CredentialProvider"),
    updateOauth2CredentialProvider: unexpected("updateOauth2CredentialProvider"),
    getPaymentCredentialProvider: unexpected("getPaymentCredentialProvider"),
    createPaymentCredentialProvider: unexpected("createPaymentCredentialProvider"),
    updatePaymentCredentialProvider: unexpected("updatePaymentCredentialProvider"),
    deleteApiKeyCredentialProvider: unexpected("deleteApiKeyCredentialProvider"),
    deleteOauth2CredentialProvider: unexpected("deleteOauth2CredentialProvider"),
    deletePaymentCredentialProvider: unexpected("deletePaymentCredentialProvider"),
  };
}

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
  removePaymentCredentials?: PaymentCredentialRemover;
  /** Stack returned by CloudFormation. Defaults to a present stack; null means absent. */
  describedStack?: Stack | null;
  /** Chunks the fake synth process streams through onOutput. */
  synthOutput?: string[];
  /** Lines the fake Toolkit reports through each operation's onOutput sink. */
  cdkOutput?: string[];
};

function harness(options: HarnessOptions = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  const runs: { operation: CdkOperation; options: CdkRunOptions }[] = [];
  const credentialRegions: string[] = [];
  const accountCredentials: CdkCredentialProvider[] = [];
  const bootstrapCredentials: CdkCredentialProvider[] = [];
  const accountRegions: string[] = [];
  const bootstrapRegions: string[] = [];
  const stackReads: { stackName: string; region: string; credentials: CdkCredentialProvider }[] =
    [];
  let templateLoads = 0;
  let templateCleanups = 0;
  const credentials: CdkCredentialProvider = async () => ({
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
  });

  const backend = new CdkBackend({
    logger: createSilentLogger(),
    identity: unusedIdentity(),
    runner: async (command, { cwd, onOutput }) => {
      commands.push({ command, cwd });
      for (const chunk of options.synthOutput ?? []) onOutput?.(chunk);
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
      for (const line of options.cdkOutput ?? []) runOptions.onOutput?.(line);
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
    ...(options.removePaymentCredentials && {
      removePaymentCredentials: options.removePaymentCredentials,
    }),
    describeStack: async (region, provider, stackName) => {
      stackReads.push({ stackName, region, credentials: provider });
      if (options.describedStack === null) return undefined;
      return (
        options.describedStack ?? {
          StackName: stackName,
          CreationTime: new Date(0),
          StackStatus: "CREATE_COMPLETE",
        }
      );
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
    runs,
    stackReads,
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

/**
 * The step messages in order, dropping the streamed `output` lines. Ordering
 * assertions are about the steps: the output events interleaved between them are
 * whatever the fake process happened to emit.
 */
function stepMessages(events: ProjectEvent[]): string[] {
  return events.flatMap((event) => (event.type === "step" ? [event.message] : []));
}

describe("CdkBackend.build", () => {
  test("synthesizes into the assembly directory deploy reads", async () => {
    const input = await project();
    const subject = harness();

    expect(await collect(subject.backend.build(input))).toEqual([
      { type: "step", message: "Synthesizing CloudFormation templates" },
    ]);
    expect(subject.commands).toEqual([{ command: synthCommand(input), cwd: cdkDirectory(input) }]);
  });

  test("streams synth output as line-buffered output events", async () => {
    const input = await project();
    // The chunk boundary splits a line, so a chunk-per-event bridge would leak
    // the fragments "line t" / "wo".
    const subject = harness({ synthOutput: ["line one\nline t", "wo\ntrailing partial"] });

    expect(await collect(subject.backend.build(input))).toEqual([
      { type: "step", message: "Synthesizing CloudFormation templates" },
      { type: "output", line: "line one" },
      { type: "output", line: "line two" },
      { type: "output", line: "trailing partial" },
    ]);
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
      identity: unusedIdentity(),
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
      { type: "step", message: `Verifying AWS account ${TARGET.account}` },
      { type: "step", message: "Synthesizing CloudFormation templates" },
      { type: "step", message: "Deploying AgentCore-example-default-0" },
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
          // The backend wires each operation's Toolkit output into its own
          // event stream through this per-operation sink.
          onOutput: expect.any(Function),
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

  test("streams Toolkit lines as output events under the deploy step", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({
      outputs: {},
      cdkOutput: ["AgentCore-example-default-0 | 4/12 | CREATE_IN_PROGRESS"],
    });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    const deployStep = deployed.events.findIndex(
      (event) => event.type === "step" && event.message.startsWith("Deploying"),
    );
    expect(deployed.events.slice(deployStep)).toEqual([
      { type: "step", message: "Deploying AgentCore-example-default-0" },
      { type: "output", line: "AgentCore-example-default-0 | 4/12 | CREATE_IN_PROGRESS" },
    ]);
  });

  test("attaches the Toolkit's recent output to a terse operation failure", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({
      failOperation: "deploy",
      cdkOutput: ["CREATE_FAILED | AWS::IAM::Role | RuntimeRole", "ROLLBACK_IN_PROGRESS"],
    });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /deploy failed[\s\S]*Recent output:[\s\S]*CREATE_FAILED \| AWS::IAM::Role \| RuntimeRole[\s\S]*ROLLBACK_IN_PROGRESS/,
    );
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
      yield { type: "step", message: "Preparing credential provider 'openai-key'" };
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
    const messages = stepMessages(deployed.events);
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
      type: "step",
      message: "Removing stack AgentCore-example-default-0",
    });
    // Destroyed explicitly, rather than by deploying an empty template and
    // letting the Toolkit infer a deletion.
    expect(subject.runs.map(({ operation }) => operation)).toEqual([
      { kind: "destroy", stackArtifactId: "AgentCore-example-default-0" },
    ]);
    expect(subject.stackReads).toEqual([
      {
        stackName: "AgentCore-example-default-0",
        region: TARGET.region,
        credentials: subject.credentials,
      },
    ]);
    expect(JSON.parse(await Bun.file(statePath).text())).toEqual({
      targets: { prod: { stackArn: "arn:stack:prod" } },
    });
  });

  test("removes the project's payment credential providers after its stack", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const removals: string[] = [];
    const removePaymentCredentials: PaymentCredentialRemover = async function* (project) {
      removals.push(project.name);
      yield { type: "step", message: "Removing credential provider 'wallet'" };
    };
    const subject = harness({ removePaymentCredentials });

    const deployed = await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    expect(removals).toEqual(["example"]);
    // After the destroy, since a resource in the stack may still be using it.
    const messages = stepMessages(deployed.events);
    expect(messages.indexOf("Removing stack AgentCore-example-default-0")).toBeLessThan(
      messages.indexOf("Removing credential provider 'wallet'"),
    );
  });

  test("hands teardown the credentials recorded before the deploy overwrote them", async () => {
    // The `project remove all` shape: the spec declares nothing, so provisioning
    // returns nothing and rewrites the credentials map to empty before teardown runs.
    // The recorded providers are the only remaining record of what to delete.
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    const recordedWallet = {
      credentialProviderArn: "arn:payment:wallet",
      authorizerType: "PaymentCredentialProvider" as const,
    };
    await writeFile(
      statePath,
      JSON.stringify({
        targets: {
          default: {
            stackArn: "arn:stack:default",
            resources: { credentials: { wallet: recordedWallet } },
          },
        },
      }),
    );

    const handed: DeployedCredentials[] = [];
    const removePaymentCredentials: PaymentCredentialRemover = async function* (
      _project,
      { recorded },
    ) {
      handed.push(recorded);
      yield { type: "step", message: "Removing credential provider 'wallet'" };
    };
    const subject = harness({ removePaymentCredentials });

    await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    expect(handed).toEqual([{ wallet: recordedWallet }]);
  });

  test("says to add a resource when there is no stack to remove either", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const subject = harness({ describedStack: null });

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

    expect(subject.stackReads).toEqual([]);
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
      type: "step",
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

describe("CdkBackend.resolveDeployedResources", () => {
  test("describes the stack once and returns only resources with deployed ID outputs", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      ...input.spec,
      runtimes: [
        {
          name: "checkout_agent",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/checkout_agent",
          runtimeVersion: "PYTHON_3_14",
        },
        {
          name: "inventory",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/inventory",
          runtimeVersion: "PYTHON_3_14",
        },
      ],
      harnesses: [{ name: "support_agent", path: "app/support_agent" }],
    });
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({
      describedStack: {
        StackName: "AgentCore-example-default",
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [
          {
            ExportName: "AgentCore-example-default-checkout-agent-RuntimeId",
            OutputValue: "checkout_agent-AbCdEf1234",
          },
          {
            ExportName: "AgentCore-example-default-Harness-support-agent-Id",
            OutputValue: "support_agent-AbCdEf1234",
          },
        ],
      },
    });

    const resources = await subject.backend.resolveDeployedResources(input, { target: TARGET });

    expect(resources).toEqual([
      {
        resourceType: "runtime",
        name: "checkout_agent",
        id: "checkout_agent-AbCdEf1234",
        target: TARGET,
      },
      {
        resourceType: "harness",
        name: "support_agent",
        id: "support_agent-AbCdEf1234",
        target: TARGET,
      },
    ]);
    expect(subject.stackReads).toHaveLength(1);
  });

  test("fails without reading AWS when the target has no deployed stack ARN", async () => {
    const input = await project();
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).rejects.toThrow(/not deployed.*project deploy --target default/s);
    expect(subject.stackReads).toEqual([]);
    expect(subject.accountCredentials).toEqual([]);
  });

  test("fails actionably when the recorded stack no longer exists", async () => {
    const input = await project();
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).rejects.toThrow(/not deployed.*project deploy --target default/s);
    expect(subject.stackReads[0]?.stackName).toBe(STACK_ARN);
  });

  test("omits configured resources that have no deployed ID output", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      ...input.spec,
      runtimes: [
        {
          name: "checkout",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/checkout",
          runtimeVersion: "PYTHON_3_14",
        },
      ],
    });
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({
      describedStack: {
        StackName: "AgentCore-example-default",
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [],
      },
    });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).resolves.toEqual([]);
  });

  test("rejects the wrong account before reading CloudFormation", async () => {
    const input = await project();
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({ account: "999900001111" });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).rejects.toThrow(/expects AWS account 111122223333.*999900001111/s);
    expect(subject.stackReads).toEqual([]);
  });
});

describe("CdkBackend.resolveProjectResources", () => {
  const out = (ExportName: string, OutputValue: string) => ({ ExportName, OutputValue });
  const key = (OutputKey: string, OutputValue: string) => ({ OutputKey, OutputValue });
  const S = "AgentCore-example-default";

  test("resolves every declared type: exports, payment OutputKeys, credential from state, nested parents, underscores", async () => {
    const input = await project();
    input.spec = {
      ...input.spec,
      runtimes: [{ name: "web" }],
      harnesses: [{ name: "chat" }],
      memories: [{ name: "user_mem" }], // an underscore becomes a dash in the export
      knowledgeBases: [{ name: "kb" }],
      credentials: [{ name: "cred" }], // read from deployed state, not the stack
      evaluators: [{ name: "ev" }],
      onlineEvalConfigs: [{ name: "oe" }],
      agentCoreGateways: [{ name: "gw", targets: [{ name: "tgt" }] }],
      policyEngines: [{ name: "pe", policies: [{ name: "pol" }] }],
      configBundles: [{ name: "cb" }],
      payments: [{ name: "pay", connectors: [{ name: "wallet_one" }] }],
    } as unknown as typeof input.spec;
    await updateTargetState(json, input.rootPath, TARGET.name, {
      stackArn: STACK_ARN,
      resources: { credentials: { cred: { credentialProviderArn: "arn:aws:cred/cred" } } },
    });
    const subject = harness({
      describedStack: {
        StackName: S,
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [
          out(`${S}-web-RuntimeArn`, "arn:runtime/web-1"),
          out(`${S}-Harness-chat-Arn`, "arn:harness/chat-1"),
          out(`${S}-Memory-user-mem-Arn`, "arn:memory/mem-1"),
          out(`${S}-KnowledgeBase-kb-Arn`, "arn:kb/kb-1"),
          out(`${S}-Evaluator-ev-Arn`, "arn:evaluator/ev-1"),
          out(`${S}-OnlineEval-oe-Arn`, "arn:online-eval/oe-1"),
          out(`${S}-Gateway-gw-Arn`, "arn:gateway/gw-1"),
          out(`${S}-GatewayTarget-tgt-Id`, "tgt-1"),
          out(`${S}-PolicyEngine-pe-Arn`, "arn:policy-engine/pe-1"),
          out(`${S}-Policy-pe-pol-Arn`, "arn:policy/pol-1"),
          out(`${S}-ConfigBundle-cb-Arn`, "arn:config-bundle/cb-1"),
          key("PaymentpayManagerArn", "arn:payment-manager/pay-1"),
          key("PaymentpaywalletoneConnectorId", "conn-1"),
        ],
      },
    });

    const resources = await subject.backend.resolveProjectResources(input, { target: TARGET });

    // [type, name, arn, [children...]] so a child under the wrong owner fails here
    const shape = (resource: ResolvedProjectResource): unknown => [
      resource.resourceType,
      resource.name,
      resource.deploymentState === "deployed" ? resource.id : undefined,
      ...(resource.children ? [resource.children.map(shape)] : []),
    ];
    expect(resources.map(shape)).toEqual([
      ["runtime", "web", "arn:runtime/web-1"],
      ["harness", "chat", "arn:harness/chat-1"],
      ["memory", "user_mem", "arn:memory/mem-1"],
      ["knowledge-base", "kb", "arn:kb/kb-1"],
      ["credential", "cred", "arn:aws:cred/cred"],
      ["evaluator", "ev", "arn:evaluator/ev-1"],
      ["online-eval", "oe", "arn:online-eval/oe-1"],
      ["gateway", "gw", "arn:gateway/gw-1", [["gateway-target", "tgt", "tgt-1"]]],
      ["policy-engine", "pe", "arn:policy-engine/pe-1", [["policy", "pol", "arn:policy/pol-1"]]],
      ["config-bundle", "cb", "arn:config-bundle/cb-1"],
      [
        "payment-manager",
        "pay",
        "arn:payment-manager/pay-1",
        [["payment-connector", "wallet_one", "conn-1"]],
      ],
    ]);
    expect(subject.stackReads).toHaveLength(1);
  });

  test("reports a declared resource the stack does not publish as local-only", async () => {
    const input = await project();
    input.spec = {
      ...input.spec,
      memories: [{ name: "shortTerm" }, { name: "longTerm" }],
    } as unknown as typeof input.spec;
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({
      describedStack: {
        StackName: S,
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [out(`${S}-Memory-shortTerm-Arn`, "arn:memory/short-1")],
      },
    });

    const resources = await subject.backend.resolveProjectResources(input, { target: TARGET });

    expect(resources).toEqual([
      {
        resourceType: "memory",
        name: "shortTerm",
        deploymentState: "deployed",
        id: "arn:memory/short-1",
      },
      { resourceType: "memory", name: "longTerm", deploymentState: "local-only" },
    ]);
  });

  test("reports local-only without reading AWS when the target has no recorded stack", async () => {
    const input = await project();
    input.spec = {
      ...input.spec,
      memories: [{ name: "mem" }],
    } as unknown as typeof input.spec;
    const subject = harness({ describedStack: null });

    const resources = await subject.backend.resolveProjectResources(input, { target: TARGET });

    expect(resources).toEqual([
      { resourceType: "memory", name: "mem", deploymentState: "local-only" },
    ]);
    expect(subject.stackReads).toEqual([]);
    expect(subject.accountCredentials).toEqual([]);
  });

  test("nests a gateway's targets under the gateway", async () => {
    const input = await project();
    input.spec = {
      ...input.spec,
      agentCoreGateways: [{ name: "gw", targets: [{ name: "owned" }, { name: "second" }] }],
    } as unknown as typeof input.spec;
    const subject = harness({ describedStack: null });

    const resources = await subject.backend.resolveProjectResources(input, { target: TARGET });

    expect(
      resources.map(({ resourceType, name, children }) => [
        resourceType,
        name,
        children?.map((child) => child.name),
      ]),
    ).toEqual([["gateway", "gw", ["owned", "second"]]]);
  });
});
