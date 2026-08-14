// Programmatic CDK operations via @aws-cdk/toolkit-lib. Deploy drives the toolkit
// in-process rather than shelling out to `npx cdk`, so its progress arrives as
// structured messages and its failures as typed errors instead of scraped stdout.
import type { IIoHost, IoMessageLevel, Toolkit } from "@aws-cdk/toolkit-lib";

/** A message emitted by the toolkit while an operation runs. */
export type CdkEvent = {
  level: IoMessageLevel;
  message: string;
};

export type CdkOperation =
  /** Prepare each environment (`aws://account/region`) to receive stacks. */
  | { kind: "bootstrap"; environments: string[] }
  /** Deploy one stack of the synthesized assembly, named as the assembly names it. */
  | { kind: "deploy"; stackName: string };

export type CdkRunOptions = {
  /**
   * Directory holding the synthesized cloud assembly. Deploy reads the assembly
   * `build` produced rather than re-synthesizing, so what reaches AWS is exactly
   * what was synthesized. Unused by bootstrap, which needs no assembly.
   */
  assemblyDirectory: string;
  /**
   * Region for the toolkit's own SDK calls. Each stack's account and region come
   * from the assembly, which the CDK app derives from aws-targets.json.
   */
  region: string;
};

/**
 * Runs a CDK operation, yielding the toolkit's messages as they arrive.
 * Injectable so tests exercise deploy without reaching AWS.
 */
export type CdkRunner = (
  operation: CdkOperation,
  options: CdkRunOptions,
) => AsyncGenerator<CdkEvent, void>;

/**
 * The toolkit methods an operation drives, narrowed to those actually called so a
 * test can stand in for the toolkit without reaching AWS.
 */
export type CdkToolkit = Pick<Toolkit, "bootstrap" | "fromAssemblyDirectory" | "deploy">;

/** The parts of the toolkit package an operation needs, loaded on demand. */
export type CdkToolkitLib = Pick<
  typeof import("@aws-cdk/toolkit-lib"),
  "BootstrapEnvironments" | "BootstrapStackParameters" | "StackSelectionStrategy"
>;

/**
 * Loads the toolkit package and builds a toolkit that reports to `ioHost`.
 *
 * Loaded here rather than imported at module scope: the toolkit is the heaviest
 * dependency in the CLI and `src/io` is reachable from every command, so a static
 * import would make even `agentcore --help` pay to load a deploy it is not doing.
 */
export async function loadCdkToolkit(
  ioHost: IIoHost,
  region: string,
): Promise<{ lib: CdkToolkitLib; toolkit: CdkToolkit }> {
  const lib = await import("@aws-cdk/toolkit-lib");
  const toolkit = new lib.Toolkit({
    ioHost,
    // Mirrors the AWS SDK's own precedence, with the resolved region as the default.
    sdkConfig: {
      baseCredentials: lib.BaseCredentials.awsCliCompatible({ defaultRegion: region }),
    },
  });
  return { lib, toolkit };
}

/** Performs one operation, awaiting the toolkit call it maps to. */
export async function performCdkOperation(
  { lib, toolkit }: { lib: CdkToolkitLib; toolkit: CdkToolkit },
  operation: CdkOperation,
  options: CdkRunOptions,
): Promise<void> {
  if (operation.kind === "bootstrap") {
    await toolkit.bootstrap(lib.BootstrapEnvironments.fromList(operation.environments), {
      // Provisions a customer-managed KMS key for the staging bucket, matching
      // the parameters the original CLI bootstraps with.
      parameters: lib.BootstrapStackParameters.withExisting({ createCustomerMasterKey: true }),
    });
    return;
  }

  const source = await toolkit.fromAssemblyDirectory(options.assemblyDirectory);
  // The assembly holds one stack per deployment target, and a deploy ships one
  // target. MUST_MATCH so a name the assembly does not contain fails loudly
  // instead of quietly deploying nothing.
  await toolkit.deploy(source, {
    stacks: {
      strategy: lib.StackSelectionStrategy.PATTERN_MUST_MATCH,
      patterns: [operation.stackName],
    },
  });
}

/**
 * Bridges the toolkit's push-based reporting to a pull-based generator.
 *
 * `drive` receives the `IIoHost` to report to and runs to completion while the
 * caller pulls: messages land in a queue this drains, so they are yielded as they
 * arrive rather than after the operation ends. A failure propagates only once the
 * queue is empty, so the error arrives after the output that explains it.
 */
export async function* streamCdkOperation(
  drive: (ioHost: IIoHost) => Promise<void>,
): AsyncGenerator<CdkEvent, void> {
  const queue: CdkEvent[] = [];
  let wake = () => {};
  let settled = false;
  let failure: unknown;

  const ioHost: IIoHost = {
    notify: async (message) => {
      queue.push({ level: message.level, message: message.message });
      wake();
    },
    // Never prompt: there is no guaranteed TTY, so an approval prompt would hang
    // rather than fail. The suggested default is the documented non-interactive
    // response, and matches the `--require-approval never` this replaces.
    requestResponse: async (request) => request.defaultResponse,
  };

  void drive(ioHost)
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      settled = true;
      wake();
    });

  while (!settled || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
  if (failure) throw failure;
}

/** The real runner: loads the toolkit, then streams the operation it performs. */
export const runCdk: CdkRunner = (operation, options) =>
  streamCdkOperation(async (ioHost) => {
    const loaded = await loadCdkToolkit(ioHost, options.region);
    await performCdkOperation(loaded, operation, options);
  });
