import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Stack } from "@aws-sdk/client-cloudformation";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson, ProcessFailedError } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectRuntimeSchema } from "../../../projectSchemas/runtime";
import { createSilentLogger } from "../../../testing";
import { TransactionSearchSetupError } from "../../../errors";
import { CdkBackend, type CdkBackendConfig } from "./cdk";
import type {
  CredentialProviderCalls,
  CredentialProvisionInput,
  CredentialProvisioner,
  CredentialRemovalInput,
  CredentialRemover,
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
const OLD_PAYMENT_PROVIDER = "example_default_wallet";
const OLD_PAYMENT_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:111122223333:" +
  `token-vault/default/paymentcredentialprovider/${OLD_PAYMENT_PROVIDER}`;
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
    spec: ProjectSpecSchema.parse({ name: "example", version: 2 }),
  };
}

type AssemblyOptions = {
  /** Overrides the resources every stack's template declares. */
  resources?: Record<string, unknown>;
  /** A custom CloudFormation stack name for every stack, as a customized CDK app sets. */
  stackName?: string;
  /** The `agentcore:localImages` metadata every stack's template records. */
  localImages?: Record<string, string>;
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
          ...(options.localImages && {
            Metadata: { "agentcore:localImages": options.localImages },
          }),
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
          stacks.flatMap((stack) => [
            [
              stack.id,
              {
                type: "aws:cloudformation:stack",
                dependencies: [`${stack.id}.assets`],
                properties: {
                  templateFile: stack.templateFile,
                  tags: { "agentcore:target-name": stack.target },
                  ...(options.stackName && { stackName: options.stackName }),
                },
              },
            ],
            [
              `${stack.id}.assets`,
              { type: "cdk:asset-manifest", properties: { file: `${stack.id}.assets.json` } },
            ],
          ]),
        ),
      },
    }),
  );
}

/** Writes a ContainerLocal image asset manifest for the runtime "agent", as the companion CDK does. */
async function writeLocalImageManifest(p: Project): Promise<void> {
  await writeFile(
    join(assemblyDirectory(p), "AgentCore-example-default-0.assets.json"),
    JSON.stringify({
      version: "36.0.0",
      files: {},
      dockerImages: {
        abc123: {
          source: { directory: "asset.abc123", platform: "linux/arm64" },
          destinations: {},
        },
      },
    }),
  );
}

type HarnessOptions = {
  assertCdkFeatures?: CdkBackendConfig["assertCdkFeatures"];
  deployedTemplate?: object | null;
  /** Thrown by GetTemplate instead of returning the deployed template. */
  getTemplateError?: Error;
  checkLocalBuilder?: CdkBackendConfig["checkLocalBuilder"];
  resolveContainerExecutable?: CdkBackendConfig["resolveContainerExecutable"];
  account?: string;
  bootstrap?: BootstrapState;
  outputs?: CdkOutputs;
  stackArn?: string;
  omitStackArn?: boolean;
  template?: boolean;
  failOperation?: CdkOperation["kind"];
  bootstrapError?: Error;
  /** When set, the injected Transaction Search enabler throws it. */
  transactionSearchError?: Error;
  provisionCredentials?: CredentialProvisioner;
  removeCredentials?: CredentialRemover;
  /** Stack returned by CloudFormation. Defaults to a present stack; null means absent. */
  describedStack?: Stack | null;
  /** Failure thrown by the fake synth process after emitting its output. */
  synthError?: Error;
  /** Failure a fake process throws for a given command, e.g. a local image build. */
  commandError?: (command: string[]) => Error | undefined;
  /** Output a fake process streams for a given command, e.g. `docker buildx inspect`. */
  commandOutput?: (command: string[]) => string | undefined;
  /** Chunks the fake synth process streams through onOutput. */
  synthOutput?: string[];
  /** Lines the fake Toolkit reports through each operation's onOutput sink. */
  cdkOutput?: string[];
};

function harness(options: HarnessOptions = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  /** BUILDX_BUILDER each command ran with, from its env (undefined when inherited). */
  const commandBuilders: { command: string[]; buildxBuilder: string | undefined }[] = [];
  const runs: { operation: CdkOperation; options: CdkRunOptions }[] = [];
  const credentialRegions: string[] = [];
  const accountCredentials: CdkCredentialProvider[] = [];
  const bootstrapCredentials: CdkCredentialProvider[] = [];
  const accountRegions: string[] = [];
  const bootstrapRegions: string[] = [];
  const transactionSearchRegions: string[] = [];
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
    assertCdkFeatures: options.assertCdkFeatures ?? (async () => {}),
    createCloudFormationClient: () =>
      ({
        send: async () => {
          if (options.getTemplateError) throw options.getTemplateError;
          return {
            TemplateBody:
              options.deployedTemplate === null
                ? undefined
                : JSON.stringify(options.deployedTemplate ?? { Resources: {} }),
          };
        },
      }) as unknown as ReturnType<NonNullable<CdkBackendConfig["createCloudFormationClient"]>>,
    checkLocalBuilder: options.checkLocalBuilder,
    // An explicit `resolveContainerExecutable: undefined` keeps the backend's own resolver.
    resolveContainerExecutable:
      "resolveContainerExecutable" in options
        ? options.resolveContainerExecutable
        : async () => "docker",
    identity: unusedIdentity(),
    runner: async (command, { cwd, env, onOutput }) => {
      commands.push({ command, cwd });
      commandBuilders.push({ command, buildxBuilder: env?.BUILDX_BUILDER });
      const commandError = options.commandError?.(command);
      if (commandError) throw commandError;
      const commandOutput = options.commandOutput?.(command);
      if (commandOutput !== undefined) onOutput?.(commandOutput);
      for (const chunk of options.synthOutput ?? []) onOutput?.(chunk);
      if (options.synthError) throw options.synthError;
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
    enableTransactionSearch: async (target) => {
      transactionSearchRegions.push(target.region);
      if (options.transactionSearchError) throw options.transactionSearchError;
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
    ...(options.removeCredentials && {
      removeCredentials: options.removeCredentials,
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
    commandBuilders,
    commands,
    credentialRegions,
    credentials,
    runs,
    stackReads,
    transactionSearchRegions,
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
  test("builds, but does not publish, each ContainerLocal image after synthesis", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "local_agent",
        build: "ContainerLocal",
        codeLocation: "app/local_agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name, "preview"], {
      localImages: { "runtime/local_agent": "abc123" },
    });
    const image = {
      source: {
        directory: "asset.abc123",
        dockerFile: "Dockerfile",
        dockerBuildArgs: { VERSION: "v1" },
        platform: "linux/arm64",
      },
      destinations: {},
    };
    // The same image in two target stacks is built once.
    for (const stack of ["AgentCore-example-default-0", "AgentCore-example-preview-1"]) {
      await writeFile(
        join(assemblyDirectory(p), `${stack}.assets.json`),
        JSON.stringify({ version: "36.0.0", files: {}, dockerImages: { abc123: image } }),
      );
    }
    // A manifest left by an earlier synth (here, before a target existed) is not built.
    await writeFile(
      join(assemblyDirectory(p), "AgentCore-example.assets.json"),
      JSON.stringify({
        version: "36.0.0",
        files: {},
        dockerImages: {
          stale999: { ...image, source: { ...image.source, directory: "asset.stale999" } },
        },
      }),
    );
    const checked: string[] = [];
    const h = harness({
      resolveContainerExecutable: async () => "finch",
      checkLocalBuilder: async (_runner, _cwd, executable) => {
        checked.push(executable);
        return {};
      },
      synthOutput: ["step 1/2\n"],
    });
    const events = await collect(h.backend.build(p));
    expect(checked).toEqual(["finch"]);
    expect(h.commands.map(({ command }) => command)).toEqual([
      synthCommand(p),
      [
        "finch",
        "build",
        "--platform",
        "linux/arm64",
        "--tag",
        "agentcore-local/example-runtime-local_agent:abc123",
        "--file",
        "Dockerfile",
        "--build-arg",
        "VERSION=v1",
        ".",
      ],
    ]);
    expect(h.commands[1]?.cwd).toBe(join(assemblyDirectory(p), "asset.abc123"));
    expect(stepMessages(events)).toContain(
      "building runtime/local_agent image agentcore-local/example-runtime-local_agent:abc123",
    );
    expect(events.some((event) => event.type === "output")).toBe(true);
    expect(h.runs).toHaveLength(0);
    expect(h.credentialRegions).toHaveLength(0);
  });
  test("loads Docker buildx images and warns about a non-docker driver", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name], { localImages: { "runtime/agent": "abc123" } });
    await writeLocalImageManifest(p);
    const h = harness({
      resolveContainerExecutable: async () => "docker",
      checkLocalBuilder: async () => ({
        buildx: { name: "multiarch-builder", driver: "docker-container" },
      }),
    });
    const events = await collect(h.backend.build(p));
    expect(h.commands[1]?.command.slice(0, 3)).toEqual(["docker", "build", "--load"]);
    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings.map((event) => event.message).join("\n")).toContain(
      "build and publish with the docker-driver builder of the active Docker context",
    );
  });
  test("names the build context and Dockerfile when a local image build fails", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
        dockerfile: "Dockerfile.agent",
      }),
    );
    await writeAssembly(p, [TARGET.name], { localImages: { "runtime/agent": "abc123" } });
    await writeLocalImageManifest(p);
    const h = harness({
      checkLocalBuilder: async () => ({}),
      commandError: (command) =>
        command[1] === "build" ? new Error("COPY requirements.txt: not found") : undefined,
    });
    const error = await collect(h.backend.build(p)).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Building the runtime/agent image failed.");
    expect(message).toContain("Build context: app/agent/");
    expect(message).toContain("Dockerfile: app/agent/Dockerfile.agent");
    expect(message).toContain("COPY requirements.txt: not found");
  });
  test("checks CDK support for a pre-built image Runtime and builds nothing locally", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "image",
        build: "Container",
        codeLocation: "app/image",
        entrypoint: "main.py",
        containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const probed: unknown[] = [];
    const h = harness({
      assertCdkFeatures: async (_directory, features) => {
        probed.push(features);
      },
      resolveContainerExecutable: async () => {
        throw new Error("must not detect a builder");
      },
    });
    await collect(h.backend.build(p));
    expect(probed).toEqual([["Runtime containerUri"]]);
    expect(h.commands.map(({ command }) => command)).toEqual([synthCommand(p)]);
  });
  test("builds no images when no workload builds locally", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "Container",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    const h = harness({
      resolveContainerExecutable: async () => {
        throw new Error("must not detect a builder");
      },
      checkLocalBuilder: async () => {
        throw new Error("build must not probe Docker");
      },
    });
    await collect(h.backend.build(p));
    expect(h.commands.map(({ command }) => command)).toEqual([synthCommand(p)]);
  });
  test("synthesizes into the assembly directory deploy reads", async () => {
    const input = await project();
    const subject = harness();

    expect(await collect(subject.backend.build(input))).toEqual([
      { type: "step", message: "synthesizing CloudFormation templates" },
    ]);
    expect(subject.commands).toEqual([{ command: synthCommand(input), cwd: cdkDirectory(input) }]);
  });

  test("warns but continues when the installed CDK is legacy", async () => {
    const input = await project();
    const packageDirectory = join(cdkDirectory(input), "node_modules", "@aws", "agentcore-cdk");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ version: "1.0.0-rc.1" }),
    );
    const subject = harness();

    expect(await collect(subject.backend.build(input))).toEqual([
      {
        type: "warning",
        message: expect.stringContaining("Update the CDK dependency, then rebuild or redeploy."),
      },
      { type: "step", message: "synthesizing CloudFormation templates" },
    ]);
    expect(subject.commands).toEqual([{ command: synthCommand(input), cwd: cdkDirectory(input) }]);
  });

  test("streams synth output as line-buffered output events", async () => {
    const input = await project();
    // The chunk boundary splits a line, so a chunk-per-event bridge would leak
    // the fragments "line t" / "wo".
    const subject = harness({ synthOutput: ["line one\nline t", "wo\ntrailing partial"] });

    expect(await collect(subject.backend.build(input))).toEqual([
      { type: "step", message: "synthesizing CloudFormation templates" },
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
      enableTransactionSearch: async () => {},
      runner: async () => {
        throw new Error("cdk synth exploded");
      },
      checkTool: async () => {},
    });

    await expect(collect(subject.build(input))).rejects.toThrow("cdk synth exploded");
  });

  test.each([
    ['Credential "gateway-oauth" not found in deployed state', "gateway-oauth"],
    [
      'Credential "gateway-oauth" has no clientSecretArn in deployed state; the gateway role needs it to read the secret.',
      "gateway-oauth",
    ],
    [
      'Skill git auth references credential "github-token", but no deployed credential provider ARN was found.',
      "github-token",
    ],
    [
      'Payment connector "wallet" on manager "payments" references credential "coinbase", but no deployed credential provider was found for it.',
      "coinbase",
    ],
  ])("explains credential dependencies that require a first deploy", async (output, name) => {
    const input = await project();
    const failure = new ProcessFailedError(synthCommand(input), cdkDirectory(input), 1, output);
    const subject = harness({ synthError: failure });

    await expect(collect(subject.backend.build(input))).rejects.toThrow(
      `Project build cannot resolve credential "${name}" before its first deployment. ` +
        `Run 'agentcore deploy' to provision the credential and build the project.`,
    );
  });
});

describe("CdkBackend.deploy", () => {
  test.each(["build", "deploy"] as const)(
    "%s resolves a relative CDK_DOCKER against the current directory",
    async (operation) => {
      const p = await project();
      p.spec.runtimes.push(
        ProjectRuntimeSchema.parse({
          name: "agent",
          build: "ContainerLocal",
          codeLocation: "app/agent",
          entrypoint: "main.py",
        }),
      );
      await writeAssembly(p, [TARGET.name], { localImages: { "runtime/agent": "abc123" } });
      await writeLocalImageManifest(p);
      const checked: string[] = [];
      const h = harness({
        describedStack: null,
        resolveContainerExecutable: undefined,
        checkLocalBuilder: async (_runner, _cwd, executable) => {
          checked.push(executable);
          return {};
        },
      });
      const expected = resolve(process.cwd(), "bin", "dw");
      const previous = process.env.CDK_DOCKER;
      process.env.CDK_DOCKER = "./bin/dw";
      try {
        if (operation === "build") await collect(h.backend.build(p));
        else await collectDeploy(h.backend.deploy(p, deployInput()));
      } finally {
        if (previous === undefined) delete process.env.CDK_DOCKER;
        else process.env.CDK_DOCKER = previous;
      }
      expect(checked).toEqual([expected]);
      if (operation === "deploy") {
        const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
        expect(deployRun?.options.containerExecutable).toBe(expected);
      } else {
        expect(h.commands[1]?.command[0]).toBe(expected);
      }
    },
  );
  test.each([
    ["Container", "ContainerLocal"],
    ["ContainerLocal", "Container"],
  ])("rejects %s to %s after synthesis and before bootstrap or deploy", async (before, after) => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: after,
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      deployedTemplate: { Metadata: { "agentcore:builds": { "runtime/agent": before } } },
      checkLocalBuilder: async () => ({}),
    });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "cannot be switched into or out of ContainerLocal",
    );
    // Besides a buildx builder query, only synth ran: nothing was built or deployed.
    expect(
      h.commands.map(({ command }) => command).filter((command) => command[1] !== "buildx"),
    ).toEqual([synthCommand(p)]);
    expect(h.runs).toHaveLength(0);
    expect(h.bootstrapRegions).toHaveLength(0);
    expect(h.transactionSearchRegions).toHaveLength(0);
    expect(h.stackReads[0]?.region).toBe(TARGET.region);
    expect(h.stackReads[0]?.stackName).toBe("AgentCore-example-default-0");
  });

  test.each(["DELETE_COMPLETE", "ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS"] as const)(
    "treats a %s stack as not deployed",
    async (status) => {
      const p = await project();
      p.spec.runtimes.push(
        ProjectRuntimeSchema.parse({
          name: "agent",
          build: "ContainerLocal",
          codeLocation: "app/agent",
          entrypoint: "main.py",
        }),
      );
      await writeAssembly(p, [TARGET.name]);
      const h = harness({
        describedStack: {
          StackName: "AgentCore-example-default",
          CreationTime: new Date(0),
          StackStatus: status,
        },
        getTemplateError: new Error("GetTemplate must not be called"),
        checkLocalBuilder: async () => ({}),
      });
      await collectDeploy(h.backend.deploy(p, deployInput()));
      expect(h.runs.some((run) => run.operation.kind === "deploy")).toBe(true);
    },
  );
  test("warns and continues when the template is unreadable and nothing builds locally", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "Container",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      getTemplateError: Object.assign(new Error("denied"), { name: "AccessDenied" }),
    });
    const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings.map((event) => event.message).join("\n")).toContain(
      "cloudformation:GetTemplate",
    );
    expect(h.runs.some((run) => run.operation.kind === "deploy")).toBe(true);
  });
  test("fails closed on an unreadable template when a workload builds locally", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      getTemplateError: Object.assign(new Error("denied"), {
        name: "AccessDeniedException",
        $metadata: { httpStatusCode: 403 },
      }),
      checkLocalBuilder: async () => ({}),
    });
    const error = await collectDeploy(h.backend.deploy(p, deployInput())).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cloudformation:DescribeStacks");
    expect((error as Error).message).toContain("cloudformation:GetTemplate");
    expect(h.runs).toHaveLength(0);
    expect(h.bootstrapRegions).toHaveLength(0);
  });
  test("propagates errors other than authorization failures", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "Container",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({ getTemplateError: new Error("Rate exceeded") });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "Rate exceeded",
    );
  });
  test("refuses to deploy when the previous stack template cannot be inspected", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({ deployedTemplate: null, checkLocalBuilder: async () => ({}) });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "template is unavailable",
    );
    expect(h.runs).toHaveLength(0);
  });
  test("checks the selected target's synthesized stack, including an unchanged local workload", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    const otherTarget = { ...TARGET, name: "preview", region: "us-west-2" };
    await writeAssembly(p, [otherTarget.name]);
    const h = harness({
      deployedTemplate: {
        Metadata: { "agentcore:builds": { "runtime/agent": "ContainerLocal" } },
      },
      checkLocalBuilder: async () => ({}),
    });
    await collectDeploy(h.backend.deploy(p, deployInput({ target: otherTarget })));
    expect(h.stackReads[0]?.stackName).toBe("AgentCore-example-preview-0");
    expect(h.stackReads[0]?.region).toBe(otherTarget.region);
    expect(h.accountRegions).toEqual([otherTarget.region]);
  });
  test("checks a custom-named stack with no earlier assembly or deployed state", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    // The fake synth leaves this in place, as a first synth of a customized app writes it.
    await writeAssembly(p, [TARGET.name], { stackName: "CustomOrders" });
    const h = harness({
      deployedTemplate: { Metadata: { "agentcore:builds": { "runtime/agent": "Container" } } },
      checkLocalBuilder: async () => ({}),
    });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "cannot be switched into or out of ContainerLocal",
    );
    expect(h.stackReads[0]?.stackName).toBe("CustomOrders");
    expect(h.runs).toHaveLength(0);
  });
  test("inspects the live stack by name, not a recorded ARN of a deleted stack", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await updateTargetState(json, p.rootPath, TARGET.name, {
      stackArn:
        "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default-0/deleted",
    });
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      deployedTemplate: { Metadata: { "agentcore:builds": { "runtime/agent": "Container" } } },
      checkLocalBuilder: async () => ({}),
    });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "cannot be switched into or out of ContainerLocal",
    );
    expect(h.stackReads[0]?.stackName).toBe("AgentCore-example-default-0");
    expect(h.runs).toHaveLength(0);
  });
  test("checks CDK feature support before provisioning credentials", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "image",
        build: "Container",
        codeLocation: "app/image",
        entrypoint: "main.py",
        containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1",
      }),
    );
    let provisioned = false;
    const h = harness({
      assertCdkFeatures: async () => {
        throw new Error("CDK package lacks Runtime containerUri");
      },
      provisionCredentials: async function* () {
        provisioned = true;
        yield { type: "step", message: "provisioning credentials" };
        return {};
      },
    });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "lacks Runtime containerUri",
    );
    expect(provisioned).toBe(false);
    expect(h.commands).toHaveLength(0);
  });
  test("refuses an unavailable local builder before provisioning credentials or invoking Toolkit", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    let provisioned = false;
    const h = harness({
      checkLocalBuilder: async () => {
        throw new Error("ARM64 builder unavailable");
      },
      provisionCredentials: async function* () {
        provisioned = true;
        yield { type: "step", message: "provisioning credentials" };
        return {};
      },
    });
    await expect(collectDeploy(h.backend.deploy(p, deployInput()))).rejects.toThrow(
      "ARM64 builder unavailable",
    );
    expect(provisioned).toBe(false);
    expect(h.runs).toHaveLength(0);
    // Only the buildx builder query ran, not synth.
    expect(h.commands.map(({ command }) => command)).toEqual([["docker", "buildx", "inspect"]]);
  });

  test("reuses the workload build modes the command resolved instead of rereading harness.yaml", async () => {
    const p = await project();
    p.spec.harnesses.push({ name: "helper", path: "app/helper" });
    await mkdir(join(p.rootPath, "app", "helper"), { recursive: true });
    // Unparseable, so any reread would fail the deploy.
    await writeFile(join(p.rootPath, "app", "helper", "harness.yaml"), "name: [unclosed");
    await writeAssembly(p, [TARGET.name]);
    const reads = spyOn(fs, "readFileSync");
    try {
      const h = harness({ describedStack: null, checkLocalBuilder: async () => ({}) });
      await collectDeploy(
        h.backend.deploy(
          p,
          deployInput({ workloadBuilds: { "harness/helper": "ContainerLocal" } }),
        ),
      );
      expect(
        reads.mock.calls.filter(([path]) => String(path).endsWith("harness.yaml")),
      ).toHaveLength(0);
      // The harness from the resolved map still selects the local builder check.
      expect(h.runs.find((run) => run.operation.kind === "deploy")?.options).toHaveProperty(
        "containerExecutable",
        "docker",
      );
    } finally {
      reads.mockRestore();
    }
  });
  test("build reads each harness.yaml once for synthesis and image builds", async () => {
    const p = await project();
    p.spec.harnesses.push({ name: "helper", path: "app/helper" });
    await mkdir(join(p.rootPath, "app", "helper"), { recursive: true });
    await writeFile(
      join(p.rootPath, "app", "helper", "harness.yaml"),
      "name: helper\nmodel: {bedrockModelConfig: {modelId: test-model}}\n" +
        "dockerfile: Dockerfile\nbuild: ContainerLocal\n",
    );
    const reads = spyOn(fs, "readFileSync");
    try {
      const h = harness({ checkLocalBuilder: async () => ({}) });
      await collect(h.backend.build(p));
      expect(
        reads.mock.calls.filter(([path]) => String(path).endsWith("harness.yaml")),
      ).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });
  test("checks and hands CDK the detected container builder for ContainerLocal", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const checked: string[] = [];
    const h = harness({
      describedStack: null,
      resolveContainerExecutable: async () => "podman",
      checkLocalBuilder: async (_runner, _cwd, executable) => {
        checked.push(executable);
        return {};
      },
    });
    await collectDeploy(h.backend.deploy(p, deployInput()));
    expect(checked).toEqual(["podman"]);
    const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
    expect(deployRun?.options.containerExecutable).toBe("podman");
  });
  test("warns during deploy when the Docker buildx driver is not docker", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      describedStack: null,
      checkLocalBuilder: async () => ({
        buildx: { name: "multiarch-builder", driver: "docker-container" },
      }),
    });
    const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings.map((event) => event.message).join("\n")).toContain(
      "'multiarch-builder' uses the docker-container driver",
    );
  });
  test.each([
    ["docker", "docker-container", "desktop-linux"],
    ["/usr/local/bin/docker", "kubernetes", "desktop-linux"],
    ["docker", "docker", undefined],
    ["finch", "docker-container", undefined],
  ] as const)(
    "with %s and a %s buildx driver, hands CDK BUILDX_BUILDER=%s",
    async (executable, driver, expected) => {
      const p = await project();
      p.spec.runtimes.push(
        ProjectRuntimeSchema.parse({
          name: "agent",
          build: "ContainerLocal",
          codeLocation: "app/agent",
          entrypoint: "main.py",
        }),
      );
      await writeAssembly(p, [TARGET.name]);
      const checks: (string | undefined)[] = [];
      const h = harness({
        describedStack: null,
        resolveContainerExecutable: async () => executable,
        commandOutput: (command) =>
          command[1] === "buildx"
            ? `Name: ci\nDriver: ${driver}\n`
            : command[1] === "context"
              ? "desktop-linux\n"
              : undefined,
        checkLocalBuilder: async (_runner, _cwd, _executable, options) => {
          checks.push(options?.buildxBuilder);
          return {};
        },
      });
      await collectDeploy(h.backend.deploy(p, deployInput()));
      const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
      expect(deployRun?.options.buildxBuilder).toBe(expected);
      expect(checks).toEqual([expected]);
    },
  );
  test.each(["default", "colima"])(
    "probes and deploys with the same BUILDX_BUILDER for Docker context %s",
    async (context) => {
      const p = await project();
      p.spec.runtimes.push(
        ProjectRuntimeSchema.parse({
          name: "agent",
          build: "ContainerLocal",
          codeLocation: "app/agent",
          entrypoint: "main.py",
        }),
      );
      await writeAssembly(p, [TARGET.name]);
      // The real check runs: an x86 daemon, so the ARM64 probe builds.
      const h = harness({
        describedStack: null,
        commandOutput: (command) => {
          if (command[1] === "info") return '{"OSType":"linux","Architecture":"x86_64"}';
          if (command[1] === "context") return `${context}\n`;
          if (command[1] === "buildx") {
            // The redirected builder is the context's docker-driver builder.
            return h.commandBuilders.at(-1)?.buildxBuilder === context
              ? `Name: ${context}\nDriver: docker\n`
              : "Name: ci\nDriver: docker-container\n";
          }
          return undefined;
        },
      });
      const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
      const probe = h.commandBuilders.find(
        ({ command }) => command[1] === "build" && command.includes("linux/arm64"),
      );
      const inspects = h.commandBuilders.filter(({ command }) => command[1] === "buildx");
      const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
      expect(deployRun?.options.buildxBuilder).toBe(context);
      expect(probe?.buildxBuilder).toBe(context);
      // First the active builder is read, then the chosen one is inspected.
      expect(inspects.map(({ buildxBuilder }) => buildxBuilder)).toEqual([undefined, context]);
      const warnings = events.filter((event) => event.type === "warning").map((e) => e.message);
      expect(warnings.join("\n")).toContain(`BUILDX_BUILDER=${context}`);
    },
  );
  test("falls back to the active builder with a warning when docker context show fails", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const checks: (string | undefined)[] = [];
    const h = harness({
      describedStack: null,
      commandOutput: (command) =>
        command[1] === "buildx" ? "Name: ci\nDriver: docker-container\n" : undefined,
      commandError: (command) =>
        command[1] === "context"
          ? new Error("docker: 'context' is not a docker command")
          : undefined,
      checkLocalBuilder: async (_runner, _cwd, _executable, options) => {
        checks.push(options?.buildxBuilder);
        return { buildx: { name: "ci", driver: "docker-container" } };
      },
    });
    const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
    const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
    expect(deployRun?.options).not.toHaveProperty("buildxBuilder");
    expect(checks).toEqual([undefined]);
    const warnings = events.filter((event) => event.type === "warning").map((e) => e.message);
    const warning = warnings.find((message) => message.includes("docker context"));
    expect(warning).toContain("could not read the active Docker context");
    expect(warning).toContain("'context' is not a docker command");
    expect(warnings.join("\n")).not.toContain("BUILDX_BUILDER");
  });
  test("warns that a bring-your-own execution role needs ECR pull access", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
        executionRoleArn: "arn:aws:iam::111122223333:role/Mine",
      }),
      ProjectRuntimeSchema.parse({
        name: "other",
        build: "ContainerLocal",
        codeLocation: "app/other",
        entrypoint: "main.py",
      }),
    );
    p.spec.harnesses.push({ name: "helper", path: "app/helper" });
    await mkdir(join(p.rootPath, "app", "helper"), { recursive: true });
    await writeFile(
      join(p.rootPath, "app", "helper", "harness.yaml"),
      "name: helper\nmodel: {bedrockModelConfig: {modelId: test-model}}\n" +
        "dockerfile: Dockerfile\nbuild: ContainerLocal\n" +
        "executionRoleArn: arn:aws:iam::111122223333:role/HarnessRole\n",
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({ describedStack: null, checkLocalBuilder: async () => ({}) });
    const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
    const warnings = events.filter((event) => event.type === "warning").map((e) => e.message);
    const warning = warnings.find((message) => message.includes("executionRoleArn"));
    expect(warning).toContain("runtime/agent, harness/helper use ContainerLocal");
    expect(warning).not.toContain("runtime/other");
    expect(warning).toContain("ecr:GetAuthorizationToken on *");
    expect(warning).toContain("ecr:BatchGetImage and ecr:GetDownloadUrlForLayer");
    expect(warning).toContain("cdk-<qualifier>-container-assets-<account>-<region>");
    expect(warning).toContain("fails at first invoke");
    expect(warning).not.toContain("111122223333");
  });
  test("does not warn about execution roles the project creates", async () => {
    const p = await project();
    p.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "agent",
        build: "ContainerLocal",
        codeLocation: "app/agent",
        entrypoint: "main.py",
      }),
    );
    await writeAssembly(p, [TARGET.name]);
    const h = harness({ describedStack: null, checkLocalBuilder: async () => ({}) });
    const { events } = await collectDeploy(h.backend.deploy(p, deployInput()));
    expect(
      events.some(
        (event) => event.type === "warning" && event.message.includes("executionRoleArn"),
      ),
    ).toBe(false);
  });
  test("skips builder detection when no workload builds locally", async () => {
    const p = await project();
    await writeAssembly(p, [TARGET.name]);
    const h = harness({
      describedStack: null,
      resolveContainerExecutable: async () => {
        throw new Error("must not detect a builder");
      },
      checkLocalBuilder: async () => {
        throw new Error("must not probe a builder");
      },
    });
    await collectDeploy(h.backend.deploy(p, deployInput()));
    const deployRun = h.runs.find((run) => run.operation.kind === "deploy");
    expect(deployRun?.options).not.toHaveProperty("containerExecutable");
  });
  test("preflights, synthesizes, and deploys the selected stack", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" } });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    expect(deployed.events).toEqual([
      { type: "step", message: `verifying AWS account ${TARGET.account}` },
      { type: "step", message: "synthesizing CloudFormation templates" },
      { type: "step", message: "enabling CloudWatch Transaction Search" },
      {
        type: "step",
        message: "deploying AgentCore-example-default-0 (usually takes a few minutes)",
      },
    ]);
    expect(subject.transactionSearchRegions).toEqual([TARGET.region]);
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

  test("skips Transaction Search when the config disables it", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ outputs: { RuntimeArn: "arn:runtime" } });

    const deployed = await collectDeploy(
      subject.backend.deploy(input, deployInput({ transactionSearch: false })),
    );

    expect(deployed.events).not.toContainEqual({
      type: "step",
      message: "enabling CloudWatch Transaction Search",
    });
    expect(subject.transactionSearchRegions).toEqual([]);
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
      (event) => event.type === "step" && event.message.startsWith("deploying"),
    );
    expect(deployed.events.slice(deployStep)).toEqual([
      {
        type: "step",
        message: "deploying AgentCore-example-default-0 (usually takes a few minutes)",
      },
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

  test("records the CDK-managed BMA role with its runtime ARN for the sample client", async () => {
    const input = await project();
    input.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "bma",
        build: "Container",
        codeLocation: "app/bma",
        entrypoint: "lifecycle/server.py",
        bedrockManagedAgents: true,
      }),
    );
    await writeAssembly(input, [TARGET.name]);
    const roleArn = "arn:aws:iam::111122223333:role/ProjectBmaSessionRole";
    const runtimeArn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/bma123";
    const subject = harness({
      describedStack: {
        StackName: "AgentCore-example-default",
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [
          { ExportName: "AgentCore-example-default-BmaSessionRoleArn", OutputValue: roleArn },
          { ExportName: "AgentCore-example-default-bma-RuntimeArn", OutputValue: runtimeArn },
        ],
      },
    });

    await collectDeploy(subject.backend.deploy(input, deployInput()));

    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    const state = JSON.parse(await Bun.file(statePath).text());
    expect(state.targets.default.resources.bmaSession).toEqual({
      roleArn,
      runtimeArns: [runtimeArn],
    });

    input.spec.runtimes[0]!.bedrockManagedAgents = false;
    await collectDeploy(subject.backend.deploy(input, deployInput()));
    const afterRemoval = JSON.parse(await Bun.file(statePath).text());
    expect(afterRemoval.targets.default.resources.bmaSession).toBeUndefined();

    input.spec.runtimes[0]!.bedrockManagedAgents = undefined;
    input.spec.runtimes[0]!.tags = { "agentcore:template": "BedrockManagedAgents" };
    input.spec.runtimes[0]!.additionalPolicies = ["bma-acr-policy.json"];
    await collectDeploy(subject.backend.deploy(input, deployInput()));
    const afterMarkersOnly = JSON.parse(await Bun.file(statePath).text());
    expect(afterMarkersOnly.targets.default.resources.bmaSession).toBeUndefined();
  });

  test("reports a missing BMA role output from an older CDK dependency", async () => {
    const input = await project();
    input.spec.runtimes.push(
      ProjectRuntimeSchema.parse({
        name: "bma",
        build: "Container",
        codeLocation: "app/bma",
        entrypoint: "lifecycle/server.py",
        bedrockManagedAgents: true,
      }),
    );
    await writeAssembly(input, [TARGET.name]);
    const subject = harness();

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /Update @aws\/agentcore-cdk/,
    );
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    const state = JSON.parse(await Bun.file(statePath).text());
    expect(state.targets.default.resources.bmaSession).toBeUndefined();
  });

  test("provisions credentials for the target before synth and records them under it", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const handed: CredentialProvisionInput[] = [];
    const provisionCredentials: CredentialProvisioner = async function* (_project, provisionInput) {
      handed.push(provisionInput);
      yield { type: "step", message: "preparing credential provider 'openai-key'" };
      return { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };
    };
    const subject = harness({
      outputs: { RuntimeArn: "arn:runtime" },
      stackArn: "arn:aws:cloudformation:us-east-1:111122223333:stack/AgentCore-example-default/abc",
      provisionCredentials,
    });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    // The target's name scopes the provider names, so provisioning needs it.
    expect(handed).toEqual([
      {
        credentials: subject.credentials,
        region: TARGET.region,
        targetName: TARGET.name,
        recorded: {},
      },
    ]);
    // The credential step runs (and its ARNs are recorded) before synthesis, so
    // the assembly is synthesized against a state file that already describes them.
    const messages = stepMessages(deployed.events);
    expect(messages.indexOf("preparing credential provider 'openai-key'")).toBeLessThan(
      messages.indexOf("synthesizing CloudFormation templates"),
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

  test("skips Transaction Search (does not fail the deploy) when setup errors", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({
      outputs: { RuntimeArn: "arn:runtime" },
      transactionSearchError: new TransactionSearchSetupError("denied: logs:PutResourcePolicy"),
    });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    expect(deployed.events).toContainEqual({
      type: "step",
      message: "skipping Transaction Search: denied: logs:PutResourcePolicy",
    });
    // The stack still deploys — Transaction Search never blocks it.
    expect(deployed.result).toEqual({ outputs: { RuntimeArn: "arn:runtime" } });
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

  test("rejects an incompatible recorded payment ARN before provisioning", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      credentials: [
        { name: "wallet", authorizerType: "PaymentCredentialProvider", provider: "CoinbaseCDP" },
      ],
      payments: [
        {
          name: "MyPayments",
          connectors: [{ name: "Coinbase", provider: "CoinbaseCDP", credentialName: "wallet" }],
        },
      ],
    });
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        targets: {
          default: {
            resources: {
              credentials: {
                wallet: {
                  authorizerType: "PaymentCredentialProvider",
                  credentialProviderArn: OLD_PAYMENT_ARN,
                },
              },
            },
          },
        },
      }),
    );
    let provisioned = false;
    const provisionCredentials: CredentialProvisioner = async function* () {
      provisioned = true;
      yield { type: "step", message: "preparing payment credential" };
      return {};
    };
    const subject = harness({ provisionCredentials });

    await expect(collectDeploy(subject.backend.deploy(input, deployInput()))).rejects.toThrow(
      /connector 'Coinbase'.*credential 'wallet'.*target 'default'.*different name/s,
    );
    expect(provisioned).toBe(false);
    expect(subject.commands).toEqual([]);
    expect(subject.runs).toEqual([]);
    expect(
      JSON.parse(await Bun.file(statePath).text()).targets.default.resources.credentials.wallet
        .credentialProviderArn,
    ).toBe(OLD_PAYMENT_ARN);
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

  test("does not enable Transaction Search when the deploy is a teardown", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const subject = harness();

    await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    // A destroy must not be blocked by (or trigger) Transaction Search setup.
    expect(subject.transactionSearchRegions).toEqual([]);
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
      message: "removing stack AgentCore-example-default-0",
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

  test("removes the target's credential providers after its stack", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const removals: string[] = [];
    const removeCredentials: CredentialRemover = async function* (project) {
      removals.push(project.name);
      yield { type: "step", message: "removing credential provider 'wallet'" };
    };
    const subject = harness({ removeCredentials });

    const deployed = await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    expect(removals).toEqual(["example"]);
    // After the destroy, since a resource in the stack may still be using it.
    const messages = stepMessages(deployed.events);
    expect(messages.indexOf("removing stack AgentCore-example-default-0")).toBeLessThan(
      messages.indexOf("removing credential provider 'wallet'"),
    );
  });

  test("hands teardown the target and the providers recorded before the deploy overwrote them", async () => {
    // The `agentcore remove all` shape: the spec declares nothing, so provisioning
    // returns nothing and rewrites the credentials map to empty before teardown runs.
    // The recorded providers are the only remaining record of what to delete, and
    // the target name is what scopes their provider names.
    const input = await project();
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    const recordedWallet = {
      credentialProviderArn: OLD_PAYMENT_ARN,
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

    const handed: CredentialRemovalInput[] = [];
    const removeCredentials: CredentialRemover = async function* (_project, removalInput) {
      handed.push(removalInput);
      yield { type: "step", message: "removing credential provider 'wallet'" };
    };
    const subject = harness({ removeCredentials });

    await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    expect(handed).toEqual([
      {
        credentials: subject.credentials,
        region: TARGET.region,
        targetName: TARGET.name,
        providers: [
          {
            name: "wallet",
            authorizerType: "PaymentCredentialProvider",
            physicalName: OLD_PAYMENT_PROVIDER,
          },
        ],
      },
    ]);
  });

  test("teardown removes a declared payment credential by its recorded physical name", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      credentials: [
        { name: "wallet", authorizerType: "PaymentCredentialProvider", provider: "CoinbaseCDP" },
      ],
    });
    await writeAssembly(input, [TARGET.name], { resources: METADATA_ONLY });
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    const recordedWallet = {
      credentialProviderArn: OLD_PAYMENT_ARN,
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

    const handed: CredentialRemovalInput[] = [];
    const subject = harness({
      provisionCredentials: async function* () {
        yield { type: "step", message: "reusing existing payment credential" };
        return { wallet: recordedWallet };
      },
      removeCredentials: async function* (_project, removalInput) {
        handed.push(removalInput);
        yield { type: "step", message: "removing existing payment credential" };
      },
    });

    await collectDeploy(
      subject.backend.deploy(input, deployInput({ confirmTeardown: async () => true })),
    );

    expect(handed[0]?.providers).toEqual([
      {
        name: "wallet",
        authorizerType: "PaymentCredentialProvider",
        physicalName: OLD_PAYMENT_PROVIDER,
      },
    ]);
  });

  test("removes a recorded provider whose credential left the spec, after the stack update", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "openai-key" }],
    });
    await writeAssembly(input, [TARGET.name]);
    const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        targets: {
          default: {
            stackArn: "arn:stack:default",
            resources: {
              credentials: {
                "openai-key": {
                  credentialProviderArn: "arn:apikey:openai-key",
                  authorizerType: "ApiKeyCredentialProvider",
                },
                wallet: {
                  credentialProviderArn: OLD_PAYMENT_ARN,
                  authorizerType: "PaymentCredentialProvider",
                },
              },
            },
          },
        },
      }),
    );
    const provisionCredentials: CredentialProvisioner = async function* () {
      yield { type: "step", message: "preparing credential provider 'example_default_openai-key'" };
      return { "openai-key": { credentialProviderArn: "arn:apikey:openai-key" } };
    };
    const handed: CredentialRemovalInput[] = [];
    const removeCredentials: CredentialRemover = async function* (_project, removalInput) {
      handed.push(removalInput);
      yield { type: "step", message: "removing credential provider 'example_default_wallet'" };
    };
    const subject = harness({ provisionCredentials, removeCredentials });

    const deployed = await collectDeploy(subject.backend.deploy(input, deployInput()));

    // Only the dropped credential's provider goes: the declared one was just provisioned.
    expect(handed).toEqual([
      {
        credentials: subject.credentials,
        region: TARGET.region,
        targetName: TARGET.name,
        providers: [
          {
            name: "wallet",
            authorizerType: "PaymentCredentialProvider",
            physicalName: OLD_PAYMENT_PROVIDER,
          },
        ],
      },
    ]);
    // After the stack update, since a resource in the stack may have used the
    // provider until this deploy removed the reference.
    const messages = stepMessages(deployed.events);
    expect(
      messages.indexOf("deploying AgentCore-example-default-0 (usually takes a few minutes)"),
    ).toBeLessThan(messages.indexOf("removing credential provider 'example_default_wallet'"));
    expect(deployed.result).toEqual({ outputs: {} });
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
      message: `bootstrapping aws://${TARGET.account}/${TARGET.region}`,
    });
  });

  test("neither probes nor bootstraps when bootstrap is managed externally", async () => {
    const input = await project();
    await writeAssembly(input, [TARGET.name]);
    const subject = harness({ bootstrap: { kind: "absent" } });

    await collectDeploy(subject.backend.deploy(input, deployInput({ skipBootstrap: true })));

    expect(subject.bootstrapRegions).toEqual([]);
    expect(subject.runs.map(({ operation }) => operation)).toEqual([
      { kind: "deploy", stackArtifactId: "AgentCore-example-default-0" },
    ]);
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
      agentCoreGateways: [{ name: "tools-gateway", targets: [] }],
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
          {
            ExportName: "AgentCore-example-default-Gateway-tools-gateway-Id",
            OutputValue: "tools-gateway-abcdef1234",
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
        credentialProvider: subject.credentials,
      },
      {
        resourceType: "harness",
        name: "support_agent",
        id: "support_agent-AbCdEf1234",
        target: TARGET,
        credentialProvider: subject.credentials,
      },
      {
        resourceType: "gateway",
        name: "tools-gateway",
        id: "tools-gateway-abcdef1234",
        target: TARGET,
        credentialProvider: subject.credentials,
      },
    ]);
    expect(subject.stackReads).toHaveLength(1);
  });

  test("resolves resources from a legacy stack name when the target has no stack ARN", async () => {
    const input = await project();
    input.spec = ProjectSpecSchema.parse({
      ...input.spec,
      harnesses: [{ name: "support", path: "app/support" }],
    });
    await updateTargetState(json, input.rootPath, TARGET.name, {
      resources: { stackName: "AgentCore-example-default" },
    });
    const subject = harness({
      describedStack: {
        StackName: "AgentCore-example-default",
        CreationTime: new Date(0),
        StackStatus: "CREATE_COMPLETE",
        Outputs: [
          {
            ExportName: "AgentCore-example-default-Harness-support-Id",
            OutputValue: "support-AbCdEf1234",
          },
        ],
      },
    });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).resolves.toEqual([
      {
        resourceType: "harness",
        name: "support",
        id: "support-AbCdEf1234",
        target: TARGET,
        credentialProvider: subject.credentials,
      },
    ]);
    expect(subject.stackReads[0]?.stackName).toBe("AgentCore-example-default");
  });

  test("fails without reading AWS when the target has no recorded stack", async () => {
    const input = await project();
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).rejects.toThrow(/not deployed.*agentcore deploy --target default/s);
    expect(subject.stackReads).toEqual([]);
    expect(subject.accountCredentials).toEqual([]);
  });

  test("fails actionably when the recorded stack no longer exists", async () => {
    const input = await project();
    await updateTargetState(json, input.rootPath, TARGET.name, { stackArn: STACK_ARN });
    const subject = harness({ describedStack: null });

    await expect(
      subject.backend.resolveDeployedResources(input, { target: TARGET }),
    ).rejects.toThrow(/not deployed.*agentcore deploy --target default/s);
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

    // [type, name, identifier field, identifier, [children...]] so both the
    // identifier kind and a child under the wrong owner fail here.
    const shape = (resource: ResolvedProjectResource): unknown => [
      resource.resourceType,
      resource.name,
      resource.deploymentState === "deployed" ? ("arn" in resource ? "arn" : "id") : undefined,
      resource.deploymentState === "deployed"
        ? "arn" in resource
          ? resource.arn
          : resource.id
        : undefined,
      ...(resource.children ? [resource.children.map(shape)] : []),
    ];
    expect(resources.map(shape)).toEqual([
      ["runtime", "web", "arn", "arn:runtime/web-1"],
      ["harness", "chat", "arn", "arn:harness/chat-1"],
      ["memory", "user_mem", "arn", "arn:memory/mem-1"],
      ["knowledge-base", "kb", "arn", "arn:kb/kb-1"],
      ["credential", "cred", "arn", "arn:aws:cred/cred"],
      ["evaluator", "ev", "arn", "arn:evaluator/ev-1"],
      ["online-eval", "oe", "arn", "arn:online-eval/oe-1"],
      ["gateway", "gw", "arn", "arn:gateway/gw-1", [["gateway-target", "tgt", "id", "tgt-1"]]],
      [
        "policy-engine",
        "pe",
        "arn",
        "arn:policy-engine/pe-1",
        [["policy", "pol", "arn", "arn:policy/pol-1"]],
      ],
      ["config-bundle", "cb", "arn", "arn:config-bundle/cb-1"],
      [
        "payment-manager",
        "pay",
        "arn",
        "arn:payment-manager/pay-1",
        [["payment-connector", "wallet_one", "id", "conn-1"]],
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
        arn: "arn:memory/short-1",
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
