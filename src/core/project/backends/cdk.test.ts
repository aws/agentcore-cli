import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Stack } from "@aws-sdk/client-cloudformation";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger } from "../../../testing";
import { CdkBackend } from "./cdk";
import { DEPLOYED_STATE_RELATIVE_PATH, updateTargetState } from "./cdk/deployedState";
import type { DeployBackendInput } from "./types";
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
  /** Stack returned by CloudFormation. Defaults to a present stack; null means absent. */
  describedStack?: Stack | null;
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
          stackArn:
            "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
        },
      },
    });
  });

  test("fails a deploy whose result carries no stack ARN, recording nothing", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" }, omitStackArn: true });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /without a stack ARN/,
    );
    expect(existsSync(join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH))).toBe(false);
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

  test("resolves every deployed resource type: exports, payment OutputKey, credential from state, nested parents, underscores", async () => {
    const input = await project();
    // The resolver only reads names (and nested target/policy names), so a
    // hand-shaped spec is enough here — schema validity is tested elsewhere.
    input.spec = {
      ...input.spec,
      runtimes: [{ name: "web" }],
      harnesses: [{ name: "chat" }],
      memories: [{ name: "user_mem" }], // underscore must map to -user-mem-
      knowledgeBases: [{ name: "kb" }],
      credentials: [{ name: "cred" }], // id comes from deployed-state, not outputs
      evaluators: [{ name: "ev" }],
      onlineEvalConfigs: [{ name: "oe" }],
      agentCoreGateways: [{ name: "gw", targets: [{ name: "tgt" }] }],
      policyEngines: [{ name: "pe", policies: [{ name: "pol" }] }],
      configBundles: [{ name: "cb" }],
      payments: [{ name: "pay" }],
    } as unknown as typeof input.spec;
    await updateTargetState(json, input.rootPath, TARGET.name, {
      stackArn: STACK_ARN,
      resources: { credentials: { cred: { credentialProviderArn: "arn:aws:cred/cred" } } },
    });
    const S = "AgentCore-example-default";
    const out = (ExportName: string, OutputValue: string) => ({ ExportName, OutputValue });
    const subject = harness({
      describedStack: {
        StackName: S,
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [
          out(`${S}-web-RuntimeId`, "web-1"),
          out(`${S}-Harness-chat-Id`, "chat-1"),
          out(`${S}-Memory-user-mem-Id`, "mem-1"),
          out(`${S}-KnowledgeBase-kb-Id`, "kb-1"),
          out(`${S}-Evaluator-ev-Id`, "ev-1"),
          out(`${S}-OnlineEval-oe-Id`, "oe-1"),
          out(`${S}-Gateway-gw-Id`, "gw-1"),
          out(`${S}-GatewayTarget-tgt-Id`, "tgt-1"),
          out(`${S}-PolicyEngine-pe-Id`, "pe-1"),
          out(`${S}-Policy-pe-pol-Id`, "pol-1"),
          out(`${S}-ConfigBundle-cb-Id`, "cb-1"),
          // payment: no ExportName — only a predictable OutputKey
          { OutputKey: "PaymentpayManagerId", OutputValue: "pay-1" },
        ],
      },
    });

    const resources = await subject.backend.resolveDeployedResources(input, { target: TARGET });

    expect(resources).toEqual([
      { resourceType: "runtime", name: "web", id: "web-1", target: TARGET },
      { resourceType: "harness", name: "chat", id: "chat-1", target: TARGET },
      { resourceType: "memory", name: "user_mem", id: "mem-1", target: TARGET },
      { resourceType: "knowledge-base", name: "kb", id: "kb-1", target: TARGET },
      { resourceType: "credential", name: "cred", id: "arn:aws:cred/cred", target: TARGET },
      { resourceType: "evaluator", name: "ev", id: "ev-1", target: TARGET },
      { resourceType: "online-eval", name: "oe", id: "oe-1", target: TARGET },
      { resourceType: "gateway", name: "gw", id: "gw-1", target: TARGET },
      { resourceType: "gateway-target", name: "tgt", parent: "gw", id: "tgt-1", target: TARGET },
      { resourceType: "policy-engine", name: "pe", id: "pe-1", target: TARGET },
      { resourceType: "policy", name: "pol", parent: "pe", id: "pol-1", target: TARGET },
      { resourceType: "config-bundle", name: "cb", id: "cb-1", target: TARGET },
      { resourceType: "payment", name: "pay", id: "pay-1", target: TARGET },
    ]);
    expect(subject.stackReads).toHaveLength(1);
  });

  test("omits a declared non-runtime resource that has no deployed output", async () => {
    const input = await project();
    input.spec = {
      ...input.spec,
      runtimes: [],
      harnesses: [],
      memories: [{ name: "mem" }],
    } as unknown as typeof input.spec;
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

  test("allowMissing returns [] instead of throwing when the target has no stack ARN", async () => {
    const input = await project();
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET, allowMissing: true }),
    ).resolves.toEqual([]);
    expect(subject.stackReads).toEqual([]);
  });

  test("allowMissing returns [] instead of throwing when the recorded stack is gone", async () => {
    const input = await project();
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET, allowMissing: true }),
    ).resolves.toEqual([]);
  });

  test("allowMissing does not swallow a wrong-account error", async () => {
    const input = await project();
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({ account: "999900001111" });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET, allowMissing: true }),
    ).rejects.toThrow(/expects AWS account 111122223333.*999900001111/s);
  });
});
