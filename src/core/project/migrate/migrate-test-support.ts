import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CreateStackRefactorCommand,
  DescribeStackRefactorCommand,
  DescribeStacksCommand,
  ExecuteStackRefactorCommand,
  GetStackPolicyCommand,
  GetTemplateCommand,
  ListStackRefactorActionsCommand,
  ListStackResourcesCommand,
  type CloudFormationClient,
  type ResourceMapping,
} from "@aws-sdk/client-cloudformation";
import { ProcessFailedError, type ProcessRunner } from "../../../io";
import type { V0DeployedState } from "../../../projectSchemas/v0";
import type { CreateCloudFormationClient } from "../../types";
import type { AccountResolver } from "../backends/cdk/environment";
import type { CdkCredentialResolver } from "../backends/cdk/toolkit";
import type { WorkspaceSynthesizer } from "./synth";
import { FsAssetSource, type AssetSource } from "../source";
import { MIN_MIGRATED_FROM_CDK_VERSION } from "./index";
import type { CfnTemplate } from "./templates";
import type { TemplateStore } from "./templateStore";

/** A deployed v0 project shaped like the live-tested F1 fixture, trimmed to one of each resource. */
export const F1_SPEC = {
  $schema: "https://schema.agentcore.aws.dev/v1/agentcore.json",
  name: "CompatA",
  version: 1,
  managedBy: "CDK",
  runtimes: [
    {
      name: "CompatAAgent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/CompatAAgent/",
      runtimeVersion: "PYTHON_3_14",
      networkMode: "PUBLIC",
      protocol: "HTTP",
    },
  ],
  memories: [
    {
      name: "CompatAAgentMemory",
      eventExpiryDuration: 30,
      strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }],
    },
  ],
  knowledgeBases: [],
  credentials: [
    { authorizerType: "ApiKeyCredentialProvider", name: "compatA-key" },
    {
      authorizerType: "OAuthCredentialProvider",
      name: "compatA-oauth",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scopes: ["openid"],
      vendor: "CustomOauth2",
      usage: "outbound",
    },
  ],
  evaluators: [
    {
      name: "CompatAJudge",
      level: "TRACE",
      config: {
        llmAsAJudge: {
          model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          instructions: "Context: {context}. Assistant turn: {assistant_turn}. Rate it.",
          ratingScale: { numerical: [{ value: 1, label: "Poor", definition: "Bad" }] },
        },
      },
    },
  ],
  onlineEvalConfigs: [
    {
      name: "CompatAOnline",
      agent: "CompatAAgent",
      evaluators: ["CompatAJudge"],
      samplingRate: 10,
    },
  ],
  agentCoreGateways: [
    {
      name: "CompatAGw",
      targets: [
        {
          name: "awsknowledge",
          targetType: "mcpServer",
          endpoint: "https://knowledge-mcp.global.api.aws",
        },
      ],
      authorizerType: "AWS_IAM",
      policyEngineConfiguration: { policyEngineName: "CompatAPE", mode: "LOG_ONLY" },
    },
  ],
  policyEngines: [
    {
      name: "CompatAPE",
      policies: [{ name: "CompatAPolicy", statement: "permit(principal, action, resource);" }],
    },
  ],
  configBundles: [
    {
      name: "CompatABundle",
      type: "ConfigurationBundle",
      components: { "{{runtime:CompatAAgent}}": { configuration: { systemPrompt: "Hi." } } },
    },
  ],
  abTests: [],
  harnesses: [{ name: "CompatAHarness", path: "app/CompatAHarness" }],
  datasets: [],
  capacityProviders: [],
  payments: [],
};

const ARN = "arn:aws:bedrock-agentcore:us-east-1:998846730471";

/** F1's deployed state as v0 0.31.1 recorded it after a deploy to `default`. */
export const F1_DEPLOYED_STATE = {
  targets: {
    default: {
      resources: {
        runtimes: {
          CompatAAgent: {
            runtimeId: "CompatA_CompatAAgent-5ITOUFEJg5",
            runtimeArn: `${ARN}:runtime/CompatA_CompatAAgent-5ITOUFEJg5`,
            roleArn: "arn:aws:iam::998846730471:role/r",
          },
        },
        memories: {
          CompatAAgentMemory: {
            memoryId: "CompatA_CompatAAgentMemory-ZnaBgH2oeH",
            memoryArn: `${ARN}:memory/CompatA_CompatAAgentMemory-ZnaBgH2oeH`,
          },
        },
        gateways: {
          CompatAGw: {
            gatewayId: "compata-compatagw-nmv1g37e5a",
            gatewayArn: `${ARN}:gateway/compata-compatagw-nmv1g37e5a`,
          },
        },
        credentials: {
          "compatA-key": {
            credentialProviderArn: `${ARN}:token-vault/default/apikeycredentialprovider/compatA-key`,
          },
          "compatA-oauth": {
            credentialProviderArn: `${ARN}:token-vault/default/oauth2credentialprovider/compatA-oauth`,
          },
        },
        evaluators: {
          CompatAJudge: {
            evaluatorId: "CompatA_CompatAJudge-e9RwOP3mWm",
            evaluatorArn: `${ARN}:evaluator/CompatA_CompatAJudge-e9RwOP3mWm`,
          },
        },
        onlineEvalConfigs: {
          CompatAOnline: {
            onlineEvaluationConfigId: "CompatA_CompatAOnline-rfslDjHfL1",
            onlineEvaluationConfigArn: `${ARN}:online-evaluation-config/CompatA_CompatAOnline-rfslDjHfL1`,
          },
        },
        configBundles: {
          CompatABundle: {
            bundleId: "CompatACompatABundle-40Z0rLD2Ri",
            bundleArn: `${ARN}:configuration-bundle/CompatACompatABundle-40Z0rLD2Ri`,
            versionId: "64dcd57f-bdaa-4493-834c-a813e53a0a9a",
          },
        },
        policyEngines: {
          CompatAPE: {
            policyEngineId: "CompatA_CompatAPE-xmuuz2hdnb",
            policyEngineArn: `${ARN}:policy-engine/CompatA_CompatAPE-xmuuz2hdnb`,
          },
        },
        policies: {
          "CompatAPE/CompatAPolicy": {
            policyId: "CompatAPolicy-mh6mcusj2j",
            policyArn: `${ARN}:policy-engine/CompatA_CompatAPE-xmuuz2hdnb/policy/CompatAPolicy-mh6mcusj2j`,
            engineName: "CompatAPE",
          },
        },
        harnesses: {
          CompatAHarness: {
            harnessId: "CompatA_CompatAHarness-frP175fqBI",
            harnessArn: `${ARN}:harness/CompatA_CompatAHarness-frP175fqBI`,
            roleArn: "arn:aws:iam::998846730471:role/CompatA_CompatAHarness",
            status: "READY",
            provisioner: "cloudformation",
          },
        },
        stackName: "AgentCore-CompatA-default",
      },
    },
  },
};

export const F1_HARNESS = {
  name: "CompatAHarness",
  model: { provider: "bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  tools: [],
  skills: [],
  memory: { mode: "disabled" },
};

export type V0ProjectFiles = {
  spec?: unknown;
  /** `null` leaves the file out. */
  deployedState?: unknown;
  targets?: unknown;
  /** The `@aws/agentcore-cdk` pin in agentcore/cdk/package.json; `null` leaves the file out. */
  cdkPin?: string | null;
  /** The release whose vended agentcore/cdk app to write (a `__fixtures__/v0-app/app-*.json`); 0.31.1 by default. */
  app?: string;
  /** Extra files by project-relative path. */
  files?: Record<string, string>;
};

/** Writes a v0 project into a fresh temporary directory and returns its root. */
export async function writeV0Project(
  options: V0ProjectFiles = {},
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-migrate-test-"));
  const files: Record<string, string> = {
    "agentcore/agentcore.json": json(options.spec ?? F1_SPEC),
    "agentcore/aws-targets.json": json(
      options.targets ?? [{ name: "default", account: "998846730471", region: "us-east-1" }],
    ),
    "agentcore/.gitignore":
      ".env.local\ncdk/cdk.out/\ncdk/node_modules/\n.cli/*\n!.cli/deployed-state.json\n",
    // The app the release vends, as `agentcore create` wrote it (package.json below).
    ...Object.fromEntries(
      Object.entries(v0App(options.app ?? "0.31.1"))
        .filter(([file]) => file !== "package.json")
        .map(([file, content]) => [`agentcore/cdk/${file}`, content]),
    ),
    "agentcore/cdk/node_modules/@aws/agentcore-cdk/index.js": "// dependency\n",
    "agentcore/cdk/cdk.out/manifest.json": "{}\n",
    "app/CompatAHarness/harness.json": json(F1_HARNESS),
    "app/CompatAHarness/system-prompt.md": "You are helpful.\n",
    "app/CompatAAgent/main.py": "print('hi')\n",
    ...options.files,
  };
  if (options.deployedState !== null) {
    files["agentcore/.cli/deployed-state.json"] = json(options.deployedState ?? F1_DEPLOYED_STATE);
  }
  if (options.cdkPin !== null) {
    const manifest = JSON.parse(v0App(options.app ?? "0.31.1")["package.json"]!) as {
      dependencies: Record<string, string>;
    };
    if (options.cdkPin !== undefined) manifest.dependencies["@aws/agentcore-cdk"] = options.cdkPin;
    files["agentcore/cdk/package.json"] = json(manifest);
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Commits everything in `root` to a new git repository, with a fixed identity. */
export function commitAll(root: string): void {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore" },
    );
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "v0 project");
}

/** A process runner that answers git commands from a script instead of spawning git. */
export function fakeGit(responses: {
  /** git isn't installed: every command fails to spawn. */
  missing?: boolean;
  insideWorkTree?: boolean;
  /** agentcore/agentcore.json is tracked; defaults to true. */
  specTracked?: boolean;
  status?: string;
}): ProcessRunner {
  return async (command, options) => {
    if (responses.missing) {
      throw new ProcessFailedError(command, options.cwd, null, "Error: spawn git ENOENT");
    }
    // The git gate runs `git -C <project root> ...`; the root doesn't matter here.
    const args = command[1] === "-C" ? [command[0], ...command.slice(3)] : command;
    const joined = args.join(" ");
    if (joined === "git rev-parse --is-inside-work-tree") {
      if (responses.insideWorkTree === false) {
        throw new ProcessFailedError(command, options.cwd, 128, "fatal: not a git repository");
      }
      options.onOutput?.("true\n");
      return;
    }
    if (joined === "git ls-files --error-unmatch agentcore/agentcore.json") {
      if (responses.specTracked === false) {
        throw new ProcessFailedError(command, options.cwd, 1, "error: pathspec did not match");
      }
      options.onOutput?.("agentcore/agentcore.json\n");
      return;
    }
    if (
      joined ===
      "git --no-optional-locks status --porcelain --untracked-files=all -- . :(exclude)agentcore/.cli/migrate"
    ) {
      options.onOutput?.(responses.status ?? "");
      return;
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A v0 CDK app source file from `__fixtures__/v0-app`, stored as `.txt` so it isn't compiled. */
/** Every file a release's vended agentcore/cdk app has, by path relative to agentcore/cdk. */
export function v0App(release: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "v0-app", `app-${release}.json`), "utf8"),
  ) as Record<string, string>;
}

export function v0AppFixture(name: string): string {
  return readFileSync(join(import.meta.dir, "__fixtures__", "v0-app", `${name}.txt`), "utf8");
}

/** A saved CloudFormation template from `__fixtures__/templates` (account IDs sanitized). */
export function templateFixture(name: string): CfnTemplate {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "templates", `${name}.json`), "utf8"),
  ) as CfnTemplate;
}

/** A stack as the fake CloudFormation client reports it. */
export type FakeStack = {
  status?: string;
  /** A stack policy document; absent means none. */
  policy?: string;
  template?: CfnTemplate;
  /** Raw TemplateBody, overriding `template`. */
  templateBody?: string;
};

/** How a fake stack refactor turns out; by default it's created and executes. */
export type FakeRefactorOutcome = {
  /** The refactor's Status after creation; anything but CREATE_COMPLETE fails it. */
  create?: { status: string; reason?: string };
  /** Its ExecutionStatus once executed; anything but EXECUTE_COMPLETE fails it. */
  execute?: { status: string; reason?: string };
  /** ExecutionStatus for successive reads after execution, before `execute`'s. */
  executeSteps?: string[];
  /** ExecuteStackRefactor throws this; `started` says whether CloudFormation ran it anyway. */
  executeThrows?: { message: string; started: boolean };
  /** ListStackRefactorActions reports these moves instead of the requested mappings. */
  actions?: { from: string; to: string }[];
  /** Physical IDs that change when the refactor executes (a broken refactor), by new logical ID. */
  changedPhysicalIds?: Record<string, string>;
};

export type FakeCloudFormationOptions = {
  /** Decides each refactor's outcome; `index` counts refactors created for that stack, from 0. */
  refactors?: (call: { stackName: string; index: number }) => FakeRefactorOutcome;
  /** The CDK bootstrap bucket CDKToolkit reports. */
  bootstrapBucket?: string;
};

type FakeRefactor = {
  stackName: string;
  template: CfnTemplate;
  mappings: ResourceMapping[];
  outcome: FakeRefactorOutcome;
  /** DescribeStackRefactor calls so far; the first reads still in progress. */
  reads: number;
  executed: boolean;
};

/** Templates uploaded to a {@link fakeTemplateStore}, by URL, so refactors made from a URL can read them. */
const TEMPLATES_BY_URL = new Map<string, unknown>();

/** A template store that keeps uploads in memory and records them. */
export function fakeTemplateStore(): TemplateStore & { puts: string[]; removed: string[] } {
  const puts: string[] = [];
  const removed: string[] = [];
  return {
    puts,
    removed,
    async put(key, body) {
      puts.push(key);
      const url = `https://bootstrap.example/${key}`;
      TEMPLATES_BY_URL.set(url, JSON.parse(body));
      return url;
    },
    async remove(key) {
      removed.push(key);
    },
  };
}

/**
 * A CloudFormation client factory answering, from `stacks`: DescribeStacks,
 * GetStackPolicy, GetTemplate, and ListStackResources (each resource's physical ID
 * is `physical-<its logical ID when first read>`, kept as refactors move it); and
 * stack refactors (created, listed, and executed, moving the stack to the
 * refactor's template). Any other command fails the test. Records every request,
 * with the region the client was built for; `stacks` is updated as refactors
 * execute.
 */
export function fakeCloudFormation(
  stacks: Record<string, FakeStack>,
  options: FakeCloudFormationOptions = {},
): {
  create: CreateCloudFormationClient;
  calls: { command: string; input: Record<string, unknown>; region: string }[];
  stacks: Record<string, FakeStack>;
} {
  const calls: { command: string; input: Record<string, unknown>; region: string }[] = [];
  const refactors = new Map<string, FakeRefactor>();
  const created = new Map<string, number>();
  /** Each stack's physical IDs by logical ID, fixed the first time they're read. */
  const physicalIds = new Map<string, Map<string, string>>();
  const notFound = (id: string) =>
    Object.assign(new Error(`Stack with id ${id} does not exist`), { name: "ValidationError" });
  const templateOf = (stack: FakeStack): CfnTemplate =>
    stack.templateBody !== undefined
      ? (JSON.parse(stack.templateBody) as CfnTemplate)
      : (stack.template ?? {});
  const idsOf = (stackName: string): Map<string, string> => {
    let ids = physicalIds.get(stackName);
    if (!ids) {
      ids = new Map(
        Object.keys(templateOf(stacks[stackName]!).Resources ?? {}).map((id) => [
          id,
          `physical-${id}`,
        ]),
      );
      physicalIds.set(stackName, ids);
    }
    return ids;
  };

  const refactorCommand = (name: string, input: Record<string, unknown>) => {
    if (name === CreateStackRefactorCommand.name) {
      const [definition] = input.StackDefinitions as {
        StackName: string;
        TemplateBody?: string;
        TemplateURL?: string;
      }[];
      const stackName = definition!.StackName;
      if (!stacks[stackName]) throw notFound(stackName);
      idsOf(stackName);
      const index = created.get(stackName) ?? 0;
      created.set(stackName, index + 1);
      const id = `refactor-${refactors.size + 1}`;
      refactors.set(id, {
        stackName,
        template: JSON.parse(
          definition!.TemplateBody ??
            JSON.stringify(TEMPLATES_BY_URL.get(definition!.TemplateURL!)),
        ) as CfnTemplate,
        mappings: (input.ResourceMappings as ResourceMapping[]) ?? [],
        outcome: options.refactors?.({ stackName, index }) ?? {},
        reads: 0,
        executed: false,
      });
      return { StackRefactorId: id };
    }
    const id = String(input.StackRefactorId);
    const refactor = refactors.get(id);
    if (!refactor) throw new Error(`no stack refactor ${id}`);
    if (name === DescribeStackRefactorCommand.name) {
      refactor.reads += 1;
      const create = refactor.outcome.create ?? { status: "CREATE_COMPLETE" };
      if (!refactor.executed) {
        return refactor.reads === 1
          ? { StackRefactorId: id, Status: "CREATE_IN_PROGRESS", ExecutionStatus: "UNAVAILABLE" }
          : {
              StackRefactorId: id,
              Status: create.status,
              StatusReason: create.reason,
              ExecutionStatus: create.status === "CREATE_COMPLETE" ? "AVAILABLE" : "UNAVAILABLE",
            };
      }
      const step = refactor.outcome.executeSteps?.shift();
      if (step) return { StackRefactorId: id, Status: "CREATE_COMPLETE", ExecutionStatus: step };
      const execute = refactor.outcome.execute ?? { status: "EXECUTE_COMPLETE" };
      return {
        StackRefactorId: id,
        Status: "CREATE_COMPLETE",
        ExecutionStatus: execute.status,
        ExecutionStatusReason: execute.reason,
      };
    }
    if (name === ListStackRefactorActionsCommand.name) {
      const moves =
        refactor.outcome.actions ??
        refactor.mappings.map((mapping) => ({
          from: mapping.Source!.LogicalResourceId!,
          to: mapping.Destination!.LogicalResourceId!,
        }));
      // Pages of two, so callers have to follow NextToken.
      const start = Number(input.NextToken ?? 0);
      return {
        StackRefactorActions: moves.slice(start, start + 2).map(({ from, to }) => ({
          Action: "MOVE",
          Entity: "RESOURCE",
          PhysicalResourceId: idsOf(refactor.stackName).get(from),
          Description: "No configuration changes detected.",
          ResourceMapping: {
            Source: { StackName: refactor.stackName, LogicalResourceId: from },
            Destination: { StackName: refactor.stackName, LogicalResourceId: to },
          },
        })),
        ...(start + 2 < moves.length && { NextToken: String(start + 2) }),
      };
    }
    if (name === ExecuteStackRefactorCommand.name) {
      const throws = refactor.outcome.executeThrows;
      if (throws && !throws.started) throw new Error(throws.message);
      refactor.executed = true;
      // A completed refactor leaves the stack on the refactor's template, with each
      // physical ID under its new logical ID; a failed one rolls back.
      if ((refactor.outcome.execute?.status ?? "EXECUTE_COMPLETE") === "EXECUTE_COMPLETE") {
        const ids = idsOf(refactor.stackName);
        const moved = new Map(ids);
        for (const mapping of refactor.mappings) {
          const from = mapping.Source!.LogicalResourceId!;
          const to = mapping.Destination!.LogicalResourceId!;
          moved.delete(from);
          moved.set(to, ids.get(from)!);
        }
        for (const [logicalId, physicalId] of Object.entries(
          refactor.outcome.changedPhysicalIds ?? {},
        )) {
          moved.set(logicalId, physicalId);
        }
        physicalIds.set(refactor.stackName, moved);
        stacks[refactor.stackName]!.template = refactor.template;
        delete stacks[refactor.stackName]!.templateBody;
      }
      if (throws) throw new Error(throws.message);
      return {};
    }
    return undefined;
  };

  const create: CreateCloudFormationClient = (config) =>
    ({
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        calls.push({ command: name, input: command.input, region: config.region });
        if (name.includes("StackRefactor")) {
          const response = refactorCommand(name, command.input);
          if (response !== undefined) return response;
        }
        const stackName = String(command.input.StackName);
        if (name === DescribeStacksCommand.name && stackName === "CDKToolkit") {
          if (!options.bootstrapBucket) throw notFound(stackName);
          return {
            Stacks: [
              {
                StackName: stackName,
                StackStatus: "UPDATE_COMPLETE",
                Outputs: [{ OutputKey: "BucketName", OutputValue: options.bootstrapBucket }],
              },
            ],
          };
        }
        const stack = stacks[stackName];
        if (!stack) throw notFound(stackName);
        if (name === DescribeStacksCommand.name) {
          return {
            Stacks: [{ StackName: stackName, StackStatus: stack.status ?? "UPDATE_COMPLETE" }],
          };
        }
        if (name === GetStackPolicyCommand.name) return { StackPolicyBody: stack.policy };
        if (name === GetTemplateCommand.name) {
          return { TemplateBody: stack.templateBody ?? JSON.stringify(stack.template ?? {}) };
        }
        if (name === ListStackResourcesCommand.name) {
          const resources = templateOf(stack).Resources ?? {};
          const ids = idsOf(stackName);
          return {
            StackResourceSummaries: Object.entries(resources).map(([logicalId, resource]) => ({
              LogicalResourceId: logicalId,
              PhysicalResourceId: ids.get(logicalId) ?? `physical-${logicalId}`,
              ResourceType: resource.Type,
              ResourceStatus: "UPDATE_COMPLETE",
            })),
          };
        }
        throw new Error(`unexpected CloudFormation command ${name}`);
      },
    }) as unknown as CloudFormationClient;
  return { create, calls, stacks };
}

/**
 * A synthesizer that writes a cloud assembly with one stack per target instead
 * of installing and running the CDK app. Records the workspaces it was given.
 */
export function fakeSynth(
  stacks: { target: string; stackName: string; template: CfnTemplate }[],
): WorkspaceSynthesizer & { workspaces: string[] } {
  const workspaces: string[] = [];
  const synthesize = async (workspaceDirectory: string) => {
    workspaces.push(workspaceDirectory);
    const assembly = join(workspaceDirectory, "agentcore", "cdk", "cdk.out");
    await mkdir(assembly, { recursive: true });
    const artifacts: Record<string, unknown> = {};
    for (const stack of stacks) {
      const templateFile = `${stack.stackName}.template.json`;
      artifacts[stack.stackName] = {
        type: "aws:cloudformation:stack",
        properties: {
          templateFile,
          stackName: stack.stackName,
          tags: { "agentcore:target-name": stack.target },
        },
      };
      await writeFile(join(assembly, templateFile), JSON.stringify(stack.template));
    }
    await writeFile(join(assembly, "manifest.json"), JSON.stringify({ artifacts }));
    return assembly;
  };
  return Object.assign(synthesize, { workspaces });
}

/** Credentials and an account lookup that never leave the process. */
export const FAKE_AWS_IDENTITY: {
  resolveCredentials: CdkCredentialResolver;
  resolveAccount: AccountResolver;
} = {
  resolveCredentials: async () => async () => ({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
  }),
  resolveAccount: async () => "998846730471",
};

const MAXPROJ_ARN = "arn:aws:bedrock-agentcore:us-east-1:998846730471";
const maxprojId = (name: string) => `${name}-Abcde12345`;

/**
 * Every resource in the `top-mcpRuntimeTools.json` fixture (project maxproj) deployed to
 * `default`, under its v0 name. The migratedFrom contract test with `@aws/agentcore-cdk`
 * converts the fixture with it.
 */
export function maxprojDeployedState(): V0DeployedState {
  const runtime = (name: string) => ({
    runtimeId: maxprojId(`maxproj_${name}`),
    runtimeArn: `${MAXPROJ_ARN}:runtime/${maxprojId(`maxproj_${name}`)}`,
    roleArn: "arn:aws:iam::998846730471:role/r",
  });
  const byName = <T>(names: string[], make: (name: string) => T) =>
    Object.fromEntries(names.map((name) => [name, make(name)]));
  return {
    targets: {
      default: {
        resources: {
          runtimes: byName(["agentA", "agentB", "agentC", "agentD"], runtime),
          memories: byName(["mem1", "mem2"], (name) => ({
            memoryId: maxprojId(`maxproj_${name}`),
            memoryArn: `${MAXPROJ_ARN}:memory/${maxprojId(`maxproj_${name}`)}`,
          })),
          knowledgeBases: {
            "kb-docs": {
              knowledgeBaseId: "KBDOCS001A",
              knowledgeBaseArn: "arn:aws:bedrock:us-east-1:998846730471:knowledge-base/KBDOCS001A",
              dataSources: [],
            },
          },
          evaluators: byName(["evalNum", "evalCat", "evalCode", "evalExt"], (name) => ({
            evaluatorId: maxprojId(`maxproj_${name}`),
            evaluatorArn: `${MAXPROJ_ARN}:evaluator/${maxprojId(`maxproj_${name}`)}`,
          })),
          onlineEvalConfigs: byName(["oe1", "oe2"], (name) => ({
            onlineEvaluationConfigId: maxprojId(`maxproj_${name}`),
            onlineEvaluationConfigArn: `${MAXPROJ_ARN}:online-evaluation-config/${maxprojId(`maxproj_${name}`)}`,
          })),
          policyEngines: byName(["pe1"], (name) => ({
            policyEngineId: maxprojId(`maxproj_${name}`),
            policyEngineArn: `${MAXPROJ_ARN}:policy-engine/${maxprojId(`maxproj_${name}`)}`,
          })),
          configBundles: byName(["cb1"], (name) => ({
            bundleId: maxprojId(`maxproj${name}`),
            bundleArn: `${MAXPROJ_ARN}:configuration-bundle/${maxprojId(`maxproj${name}`)}`,
            versionId: "64dcd57f-bdaa-4493-834c-a813e53a0a9a",
          })),
          harnesses: byName(["h1"], (name) => ({
            harnessId: maxprojId(`maxproj_${name}`),
            harnessArn: `${MAXPROJ_ARN}:harness/${maxprojId(`maxproj_${name}`)}`,
            roleArn: `arn:aws:iam::998846730471:role/maxproj_${name}`,
            status: "READY",
            provisioner: "cloudformation",
          })),
          // gw1 sets its own resourceName, gw1-res.
          gateways: byName(["gw1", "gw2"], (name) => {
            const gatewayId = maxprojId(
              name === "gw1" ? "gw1-res" : `maxproj-${name}`,
            ).toLowerCase();
            return { gatewayId, gatewayArn: `${MAXPROJ_ARN}:gateway/${gatewayId}` };
          }),
          mcp: {
            runtimes: {
              rtTool: {
                runtimeId: maxprojId("maxproj_rtToolRuntime"),
                runtimeArn: `${MAXPROJ_ARN}:runtime/${maxprojId("maxproj_rtToolRuntime")}`,
                runtimeEndpoint: "https://rt",
              },
            },
            lambdas: byName(["lambdaPy", "lambdaTs"], (name) => ({
              functionName: `maxproj-${name}`,
              functionArn: `arn:aws:lambda:us-east-1:998846730471:function:maxproj-${name}`,
            })),
          },
        },
      },
    },
  } as V0DeployedState;
}

/**
 * v1's vended assets, with the CDK app's `@aws/agentcore-cdk` pin at `version`,
 * so the planner's library check passes (or fails) as it will once the vended pin
 * moves to a release with migratedFrom.
 */
export function vendedAssets(version = MIN_MIGRATED_FROM_CDK_VERSION): AssetSource {
  const source = new FsAssetSource();
  return {
    list: (assetDir) => source.list(assetDir),
    read: async (assetPath) => {
      const text = await source.read(assetPath);
      if (assetPath !== "cdk/package.json") return text;
      const manifest = JSON.parse(text) as { dependencies: Record<string, string> };
      manifest.dependencies["@aws/agentcore-cdk"] = version;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  };
}
