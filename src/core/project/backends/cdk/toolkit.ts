import type { IIoHost, IoMessage, Toolkit } from "@aws-cdk/toolkit-lib";
import { AgentCoreCLIError } from "../../../../errors";
import type { Logger } from "../../../../logging";

export type CdkOperation =
  | { kind: "bootstrap"; environments: string[]; templateFile?: string }
  | { kind: "deploy"; stackName: string };

export type CdkRunOptions = {
  /** Synthesized cloud assembly used by deploy operations. */
  assemblyDirectory: string;
  /** Region used for the Toolkit's own AWS SDK calls. */
  region: string;
};

export type CdkOutputs = Record<string, string>;

export type CdkRunner = (operation: CdkOperation, options: CdkRunOptions) => Promise<CdkOutputs>;

export type CdkToolkit = Pick<Toolkit, "bootstrap" | "deploy" | "fromAssemblyDirectory">;

export type CdkToolkitLib = Pick<
  typeof import("@aws-cdk/toolkit-lib"),
  | "BaseCredentials"
  | "BootstrapEnvironments"
  | "BootstrapSource"
  | "BootstrapStackParameters"
  | "StackSelectionStrategy"
>;

export type LoadedCdkToolkit = {
  lib: CdkToolkitLib;
  toolkit: CdkToolkit;
};

export type CdkToolkitLoader = (ioHost: IIoHost, region: string) => Promise<LoadedCdkToolkit>;

export function createCdkIoHost(logger: Logger): IIoHost {
  const toolkitLogger = logger.child({ component: "cdk-toolkit" });
  const notify = async (message: IoMessage<unknown>): Promise<void> => {
    toolkitLogger
      .child({
        action: message.action,
        level: message.level,
        ...(message.code && { code: message.code }),
      })
      .debug(message.message);
  };

  return {
    notify,
    requestResponse: async (request) => {
      await notify(request);
      return request.defaultResponse;
    },
  };
}

/** Loads the Toolkit only when a deploy operation needs it. */
export const loadCdkToolkit: CdkToolkitLoader = async (ioHost, region) => {
  const lib = await import("@aws-cdk/toolkit-lib");
  return {
    lib,
    toolkit: new lib.Toolkit({
      ioHost,
      color: false,
      emojis: false,
      sdkConfig: {
        baseCredentials: lib.BaseCredentials.awsCliCompatible({ defaultRegion: region }),
      },
    }),
  };
};

export async function performCdkOperation(
  { lib, toolkit }: LoadedCdkToolkit,
  operation: CdkOperation,
  options: CdkRunOptions,
): Promise<CdkOutputs> {
  if (operation.kind === "bootstrap") {
    await toolkit.bootstrap(lib.BootstrapEnvironments.fromList(operation.environments), {
      parameters: lib.BootstrapStackParameters.withExisting({
        createCustomerMasterKey: true,
      }),
      ...(operation.templateFile && {
        source: lib.BootstrapSource.customTemplate(operation.templateFile),
      }),
    });
    return {};
  }

  const source = await toolkit.fromAssemblyDirectory(options.assemblyDirectory);
  const result = await toolkit.deploy(source, {
    stacks: {
      strategy: lib.StackSelectionStrategy.PATTERN_MUST_MATCH_SINGLE,
      patterns: [operation.stackName],
    },
  });

  // PATTERN_MUST_MATCH_SINGLE throws when the pattern matches anything other
  // than one stack, so a missing result is not "no match": the Toolkit skips a
  // stack whose template has no resources, and *deletes* it if it already
  // exists. Both return normally, so reporting empty outputs here would call a
  // deletion a successful deploy.
  if (result.stacks.length !== 1) {
    throw new AgentCoreCLIError(
      `The CDK Toolkit deployed no stack for '${operation.stackName}'. ` +
        `This happens when the synthesized stack has no resources, in which case an ` +
        `existing stack of that name is deleted rather than updated.`,
    );
  }

  // A stack that deployed but declares no outputs is legitimate.
  return result.stacks[0]?.outputs ?? {};
}

export function createCdkRunner(
  logger: Logger,
  load: CdkToolkitLoader = loadCdkToolkit,
): CdkRunner {
  const ioHost = createCdkIoHost(logger);
  return async (operation, options) => {
    const loaded = await load(ioHost, options.region);
    return performCdkOperation(loaded, operation, options);
  };
}
