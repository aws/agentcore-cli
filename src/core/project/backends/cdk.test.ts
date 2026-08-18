import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CdkBackend } from "./cdk";
import type { Project, ProjectEvent } from "../../../handlers/project/types";
import { createRecordingLogger, type RecordedLog } from "../../../testing";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import type { CdkEvent, CdkOperation, CdkOutputs, CdkRunOptions } from "../../../io";

const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-backend-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Spelled as an escape so no control character lands in this file.
const ESC = "\u001b";

// The region the toolkit makes its own calls in, which is not a target's region.
const REGION = "us-west-2";
const TARGET = { name: "default", account: "111122223333", region: "us-east-1" };

// The least a spec can say and still be one: everything else, `managedBy` included,
// comes from the schema's own defaults.
const SPEC = { name: "example", version: 1 };

function cdkDirectory(root: string): string {
  return join(root, "agentcore", "cdk");
}

// The assembly directory every operation reads, which build synthesized into.
function assemblyDirectory(root: string): string {
  return join(cdkDirectory(root), "cdk.out");
}

// Synth is pinned to the directory deploy reads, so both name it the same way.
function synthCommand(root: string): string[] {
  return ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", assemblyDirectory(root)];
}

// How the generated CDK app names the stack it synthesizes for a target.
function stackName(target: string): string {
  return `AgentCore-example-${target}`;
}

// Only the parts of a scaffolded project the backend reads: the CDK app's directory,
// and the node_modules it refuses to build without.
async function project(root: string, withDependencies = true): Promise<Project> {
  const directory = cdkDirectory(root);
  await mkdir(withDependencies ? join(directory, "node_modules") : directory, { recursive: true });
  return { name: "example", rootPath: root, spec: ProjectSpecSchema.parse(SPEC) };
}

// Stands in for what synth leaves behind: a manifest with one stack per target, each
// tagged with the target it belongs to. deploy reads it to find the stack to ship, and
// the stubbed runner never writes one.
async function synthesized(root: string, targetNames: string[]): Promise<void> {
  const assembly = assemblyDirectory(root);
  await mkdir(assembly, { recursive: true });
  await writeFile(
    join(assembly, "manifest.json"),
    JSON.stringify({
      version: "36.0.0",
      artifacts: {
        // A non-stack artifact, as a real assembly has: only stacks are candidates.
        Tree: { type: "cdk:tree" },
        ...Object.fromEntries(
          targetNames.map((target) => [
            stackName(target),
            {
              type: "aws:cloudformation:stack",
              properties: { tags: { "agentcore:target-name": target } },
            },
          ]),
        ),
      },
    }),
  );
}

type RecordedCommand = { command: string[]; cwd: string };
type RecordedCdkRun = { operation: CdkOperation; options: CdkRunOptions };

// A backend whose runner records commands instead of spawning them and whose toolkit
// records operations instead of reaching AWS. `onCdk` supplies the events one operation
// emits, and the failure it ends with; `outputs` what its deploy produced;
// `bootstrapped` whether the environment already has a bootstrap stack.
function backend(
  onCdk?: (operation: CdkOperation, emit: (event: CdkEvent) => void) => void,
  runner?: () => Promise<void>,
  outputs: CdkOutputs = {},
  bootstrapped = false,
): {
  backend: CdkBackend;
  commands: RecordedCommand[];
  runs: RecordedCdkRun[];
  logs: RecordedLog[];
} {
  const commands: RecordedCommand[] = [];
  const runs: RecordedCdkRun[] = [];
  const { logger, logs } = createRecordingLogger();
  return {
    backend: new CdkBackend({
      logger,
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
        await runner?.();
      },
      cdk: async function* (operation, options) {
        runs.push({ operation, options });
        const events: CdkEvent[] = [];
        let failure: unknown;
        try {
          onCdk?.(operation, (event) => events.push(event));
        } catch (error) {
          failure = error;
        }
        // Emit before throwing, as the real runner does: the output explaining a
        // failure is only useful if the consumer sees it.
        yield* events;
        if (failure) throw failure;
        // Bootstrap produces no outputs of the project's own, as with the real runner.
        return operation.kind === "deploy" ? outputs : {};
      },
      bootstrapped: async () => bootstrapped,
      checkTool: async () => {},
    }),
    commands,
    runs,
    logs,
  };
}

async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

// The toolkit's own messages, as they landed in the log: tagged with the operation that
// reported them, unlike the backend's own lines.
function logged(logs: RecordedLog[]): { level: string; message: string }[] {
  return logs
    .filter((line) => line.bindings.cdk !== undefined)
    .map(({ level, message }) => ({ level, message }));
}

describe("CdkBackend.build", () => {
  test("compiles and synthesizes via the generated cdk script", async () => {
    const root = await inTempDirectory();
    const { backend: subject, commands } = backend();

    const events = await drain(subject.build(await project(root)));

    expect(commands).toEqual([
      {
        // --output pins the assembly where deploy looks for it, so a project that
        // sets cdk.json's `output` cannot send synth somewhere deploy never reads.
        command: synthCommand(root),
        cwd: cdkDirectory(root),
      },
    ]);
    expect(events).toEqual([{ kind: "step", message: "Synthesizing CloudFormation templates" }]);
  });

  test("fails actionably when the CDK dependencies are missing", async () => {
    const root = await inTempDirectory();
    const { backend: subject, commands } = backend();

    await expect(drain(subject.build(await project(root, false)))).rejects.toThrow(/npm install/);
    expect(commands).toEqual([]);
  });

  test("propagates a synthesis failure", async () => {
    const root = await inTempDirectory();
    const { backend: subject } = backend(undefined, () => {
      throw new Error("cdk synth exploded");
    });

    await expect(drain(subject.build(await project(root)))).rejects.toThrow("cdk synth exploded");
  });
});

describe("CdkBackend.deploy", () => {
  test("synthesizes, bootstraps the target environment, then deploys its stack", async () => {
    const root = await inTempDirectory();
    const { backend: subject, commands, runs } = backend();
    const built = await project(root);
    await synthesized(root, [TARGET.name]);
    const options = { assemblyDirectory: assemblyDirectory(root), region: REGION };

    const events = await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // Only synthesis shells out; everything that reaches AWS goes through the toolkit.
    expect(commands).toEqual([{ command: synthCommand(root), cwd: cdkDirectory(root) }]);
    expect(runs).toEqual([
      { operation: { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] }, options },
      { operation: { kind: "deploy", stackName: stackName("default") }, options },
    ]);
    expect(events).toEqual([
      { kind: "step", message: "Synthesizing CloudFormation templates" },
      { kind: "step", message: "Bootstrapping aws://111122223333/us-east-1" },
      { kind: "step", message: `Deploying ${stackName("default")}` },
    ]);
  });

  test("leaves an environment that is already bootstrapped alone", async () => {
    const root = await inTempDirectory();
    const { backend: subject, runs } = backend(undefined, undefined, {}, true);
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    const events = await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // Bootstrapping again would rewrite a stack the whole account shares, so a deploy
    // neither does it nor claims to.
    expect(runs.map(({ operation }) => operation)).toEqual([
      { kind: "deploy", stackName: stackName("default") },
    ]);
    expect(events).toEqual([
      { kind: "step", message: "Synthesizing CloudFormation templates" },
      { kind: "step", message: `Deploying ${stackName("default")}` },
    ]);
  });

  test("bootstraps only the target's environment, and ships only its stack", async () => {
    const root = await inTempDirectory();
    const { backend: subject, runs } = backend();
    const built = await project(root);
    await synthesized(root, ["staging", "prod", "default"]);

    await drain(
      subject.deploy(built, {
        target: { name: "prod", account: "444455556666", region: "eu-west-1" },
        region: REGION,
      }),
    );

    // A project with a staging and a prod target cannot reach the others by accident:
    // one deploy bootstraps one environment and ships one stack.
    expect(runs.map(({ operation }) => operation)).toEqual([
      { kind: "bootstrap", environments: ["aws://444455556666/eu-west-1"] },
      { kind: "deploy", stackName: stackName("prod") },
    ]);
  });

  test("synthesizes into the same directory the toolkit deploys from", async () => {
    const root = await inTempDirectory();
    const { backend: subject, commands, runs } = backend();
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // The invariant behind passing --output at all: whatever synth was told to write
    // is exactly what the toolkit is handed. Left to cdk.json's `output`, synth could
    // write elsewhere and deploy would ship a stale assembly while reporting success.
    const assembly = assemblyDirectory(root);
    expect(commands[0]?.command.at(-1)).toBe(assembly);
    expect(new Set(runs.map(({ options }) => options.assemblyDirectory))).toEqual(
      new Set([assembly]),
    );
  });

  test("fails when the synthesized assembly has no stack for the target", async () => {
    const root = await inTempDirectory();
    const { backend: subject, runs } = backend();
    const built = await project(root);
    // An assembly synthesized from a different target list than the one on disk — what
    // a hand-edited CDK app that stops tagging its stacks would leave behind.
    await synthesized(root, ["other"]);

    await expect(drain(subject.deploy(built, { target: TARGET, region: REGION }))).rejects.toThrow(
      /no stack for deployment target 'default'/,
    );
    // Resolved before bootstrapping, so nothing reached AWS.
    expect(runs).toEqual([]);
  });

  test("names the path it looked in when synthesis wrote no assembly", async () => {
    const root = await inTempDirectory();
    const { backend: subject, runs } = backend();
    const built = await project(root);
    // Synthesis is stubbed in these tests, so writing no manifest at all is what a real
    // synth writing somewhere else entirely would leave behind.

    await expect(drain(subject.deploy(built, { target: TARGET, region: REGION }))).rejects.toThrow(
      /No synthesized cloud assembly was found at .*manifest\.json/,
    );
    expect(runs).toEqual([]);
  });

  test("fails before touching AWS when the CDK dependencies are missing", async () => {
    const root = await inTempDirectory();
    const { backend: subject, commands, runs } = backend();
    const built = await project(root, false);
    await synthesized(root, [TARGET.name]);

    await expect(drain(subject.deploy(built, { target: TARGET, region: REGION }))).rejects.toThrow(
      /npm install/,
    );
    expect(commands).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("reports the deployed stack's outputs", async () => {
    const root = await inTempDirectory();
    const { backend: subject } = backend(undefined, undefined, {
      RuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example",
      StackNameOutput: stackName("default"),
    });
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    const events = await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // The endpoints and ARNs the deploy just created: the toolkit is the only thing that
    // knows them, so a deploy that keeps them to itself leaves the user nothing to call.
    expect(events.at(-1)).toEqual({
      kind: "outputs",
      outputs: {
        RuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example",
        StackNameOutput: stackName("default"),
      },
    });
  });

  test("reports no outputs for a stack that declares none", async () => {
    const root = await inTempDirectory();
    const { backend: subject } = backend();
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    const events = await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // Nothing above has to render an empty set of outputs, so nothing is told about one.
    expect(events.map((event) => event.kind)).toEqual(["step", "step", "step"]);
  });

  test("logs the toolkit's messages instead of reporting them as events", async () => {
    const root = await inTempDirectory();
    const { backend: subject, logs } = backend((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "info", message: "example-stack: creating CloudFormation changeset..." });
      emit({ level: "result", message: "example-stack: deployed" });
    });
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    const events = await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // A deploy reports its own steps and nothing the toolkit said, so what reaches the
    // screen stays the same length however talkative a deploy turns out to be.
    expect(events).toEqual([
      { kind: "step", message: "Synthesizing CloudFormation templates" },
      { kind: "step", message: "Bootstrapping aws://111122223333/us-east-1" },
      { kind: "step", message: `Deploying ${stackName("default")}` },
    ]);
    // `result` reports an outcome rather than a severity, so it lands as info.
    expect(logged(logs)).toEqual([
      { level: "info", message: "example-stack: creating CloudFormation changeset..." },
      { level: "info", message: "example-stack: deployed" },
    ]);
  });

  test("logs each toolkit message at the severity the toolkit gave it", async () => {
    const root = await inTempDirectory();
    const { backend: subject, logs } = backend((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "debug", message: "resolved 3 environments" });
      emit({ level: "trace", message: "sdk call: DescribeStacks" });
      emit({ level: "warn", message: "example-stack: no changes" });
      emit({ level: "error", message: "example-stack: UPDATE_ROLLBACK_COMPLETE" });
    });
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // Severity is what makes the log readable once a deploy has written thousands of
    // lines to it: a failure is greppable rather than buried among the trace, which is
    // finer than any level this CLI logs at and so joins debug.
    expect(logged(logs)).toEqual([
      { level: "debug", message: "resolved 3 environments" },
      { level: "debug", message: "sdk call: DescribeStacks" },
      { level: "warn", message: "example-stack: no changes" },
      { level: "error", message: "example-stack: UPDATE_ROLLBACK_COMPLETE" },
    ]);
  });

  test("strips the colours the toolkit writes for the terminal it assumes", async () => {
    const root = await inTempDirectory();
    const { backend: subject, logs } = backend((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "info", message: `${ESC}[32m✅  example-stack${ESC}[39m` });
    });
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    await drain(subject.deploy(built, { target: TARGET, region: REGION }));

    // The log is a file, where escape codes are noise a grep has to match around.
    expect(logged(logs)).toEqual([{ level: "info", message: "✅  example-stack" }]);
  });

  test("logs the output that explains a failure before propagating it", async () => {
    const root = await inTempDirectory();
    const { backend: subject, logs } = backend((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "error", message: "example-stack: CREATE_FAILED" });
      throw new Error("cdk deploy exploded");
    });
    const built = await project(root);
    await synthesized(root, [TARGET.name]);

    await expect(drain(subject.deploy(built, { target: TARGET, region: REGION }))).rejects.toThrow(
      "cdk deploy exploded",
    );

    // The failure reaches the caller, but only the log says what went wrong, which is
    // why deploy prints where the log is.
    expect(logged(logs)).toContainEqual({
      level: "error",
      message: "example-stack: CREATE_FAILED",
    });
  });
});
