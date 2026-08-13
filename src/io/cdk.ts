// Programmatic CDK operations via @aws-cdk/toolkit-lib. Deploy drives the toolkit
// in-process rather than shelling out to `npx cdk`, so its progress arrives as
// structured messages and its failures as typed errors instead of scraped stdout.
import {
  BaseCredentials,
  BootstrapEnvironments,
  BootstrapStackParameters,
  Toolkit,
  type IIoHost,
  type IoMessageLevel,
} from "@aws-cdk/toolkit-lib";

/** A message emitted by the toolkit while an operation runs. */
export type CdkEvent = {
  level: IoMessageLevel;
  message: string;
};

export type CdkOperation =
  /** Prepare each environment (`aws://account/region`) to receive stacks. */
  | { kind: "bootstrap"; environments: string[] }
  /** Deploy every stack in the synthesized assembly. */
  | { kind: "deploy" };

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
 * The real runner. The toolkit pushes messages at an IIoHost while the caller
 * pulls them from a generator, so messages land in a queue this drains; a failure
 * propagates only once the queue is empty, so the error arrives after the output
 * that explains it.
 */
export const runCdk: CdkRunner = async function* (operation, options) {
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

  const toolkit = new Toolkit({
    ioHost,
    // Mirrors the AWS SDK's own precedence, with the resolved region as the default.
    sdkConfig: {
      baseCredentials: BaseCredentials.awsCliCompatible({ defaultRegion: options.region }),
    },
  });

  void (async () => {
    if (operation.kind === "bootstrap") {
      await toolkit.bootstrap(BootstrapEnvironments.fromList(operation.environments), {
        // Provisions a customer-managed KMS key for the staging bucket, matching
        // the parameters the original CLI bootstraps with.
        parameters: BootstrapStackParameters.withExisting({ createCustomerMasterKey: true }),
      });
      return;
    }
    const source = await toolkit.fromAssemblyDirectory(options.assemblyDirectory);
    await toolkit.deploy(source);
  })()
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
};
