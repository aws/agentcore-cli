import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  IActionAwareIoHost,
  IIoHost,
  IoMessage,
  SdkBaseConfig,
  Toolkit,
} from "@aws-cdk/toolkit-lib";
import { AgentCoreCLIError } from "../../../../errors";
import type { Logger } from "../../../../logging";

export type CdkOperation =
  | { kind: "bootstrap"; environments: string[]; templateFile?: string }
  | { kind: "deploy"; stackArtifactId: string };

export type CdkRunOptions = {
  /** Synthesized cloud assembly used by deploy operations. */
  assemblyDirectory: string;
  /** Credential provider shared with deployment preflight calls. */
  credentials: CdkCredentialProvider;
  /** Region used for the Toolkit's own AWS SDK calls. */
  region: string;
};

export type CdkOutputs = Record<string, string>;
export type CdkCredentialProvider = SdkBaseConfig["credentialProvider"];
export type CdkCredentialResolver = (region: string) => Promise<CdkCredentialProvider>;

/**
 * Result of a CDK operation. `stackArn` is the ARN of the deployed stack (only
 * a deploy produces one); bootstrap leaves it undefined.
 */
export type CdkRunResult = { outputs: CdkOutputs; stackArn?: string };

export type CdkRunner = (operation: CdkOperation, options: CdkRunOptions) => Promise<CdkRunResult>;

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

export type CdkToolkitLoader = (
  ioHost: IIoHost,
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<LoadedCdkToolkit>;

type NamedBlob = Blob & { readonly name: string };

export type LoadedBootstrapTemplate = {
  path: string;
  cleanup(): Promise<void>;
};

export type BootstrapTemplateLoader = () => Promise<LoadedBootstrapTemplate | undefined>;

const BOOTSTRAP_TEMPLATE = "bootstrap-template.yaml";

function embeddedFiles(): readonly NamedBlob[] {
  return typeof Bun === "undefined" ? [] : (Bun.embeddedFiles as readonly NamedBlob[]);
}

/** Materializes the Toolkit template embedded in a standalone executable. */
export async function loadBootstrapTemplate(
  files: readonly NamedBlob[] = embeddedFiles(),
): Promise<LoadedBootstrapTemplate | undefined> {
  const template = files.find((file) => file.name.endsWith(BOOTSTRAP_TEMPLATE));
  if (!template) {
    // No embedded files at all means a script or npm bundle, where node_modules
    // exists and the Toolkit reads the template from its own package. Embedded
    // files *without* the template means a standalone binary whose embed went
    // missing; returning undefined there sends the Toolkit looking for a package
    // directory relative to a build-time __dirname that does not exist on this
    // machine, so the user gets "Unable to find package manifest" instead.
    if (files.length > 0) {
      throw new AgentCoreCLIError(
        `This build of the CLI is missing its copy of ${BOOTSTRAP_TEMPLATE}, so it cannot ` +
          `bootstrap an AWS environment. Reinstall the CLI, or report this at ` +
          `https://github.com/aws/agentcore-cli/issues.`,
      );
    }
    return undefined;
  }

  const directory = await mkdtemp(join(tmpdir(), "agentcore-bootstrap-"));
  const path = join(directory, BOOTSTRAP_TEMPLATE);
  try {
    await writeFile(path, await template.text());
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

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

function forAction(ioHost: IIoHost, action: "deploy"): IActionAwareIoHost {
  return {
    notify: (message) => ioHost.notify({ ...message, action }),
    requestResponse: (request) => ioHost.requestResponse({ ...request, action }),
  };
}

export async function resolveCdkCredentials(
  ioHost: IIoHost,
  region: string,
): Promise<CdkCredentialProvider> {
  const { BaseCredentials } = await import("@aws-cdk/toolkit-lib");
  const config = await BaseCredentials.awsCliCompatible({
    defaultRegion: region,
  }).sdkBaseConfig(forAction(ioHost, "deploy"), {});
  return config.credentialProvider;
}

export function createCdkCredentialResolver(logger: Logger): CdkCredentialResolver {
  const ioHost = createCdkIoHost(logger);
  return (region) => resolveCdkCredentials(ioHost, region);
}

/** Loads the Toolkit only when a deploy operation needs it. */
export const loadCdkToolkit: CdkToolkitLoader = async (ioHost, region, credentials) => {
  const lib = await import("@aws-cdk/toolkit-lib");
  return {
    lib,
    toolkit: new lib.Toolkit({
      ioHost,
      color: false,
      emojis: false,
      sdkConfig: {
        baseCredentials: lib.BaseCredentials.custom({ provider: credentials, region }),
      },
    }),
  };
};

export async function performCdkOperation(
  { lib, toolkit }: LoadedCdkToolkit,
  operation: CdkOperation,
  options: CdkRunOptions,
): Promise<CdkRunResult> {
  if (operation.kind === "bootstrap") {
    await toolkit.bootstrap(lib.BootstrapEnvironments.fromList(operation.environments), {
      parameters: lib.BootstrapStackParameters.withExisting({
        createCustomerMasterKey: true,
      }),
      ...(operation.templateFile && {
        source: lib.BootstrapSource.customTemplate(operation.templateFile),
      }),
    });
    return { outputs: {} };
  }

  const source = await toolkit.fromAssemblyDirectory(options.assemblyDirectory);
  const result = await toolkit.deploy(source, {
    stacks: {
      strategy: lib.StackSelectionStrategy.PATTERN_MUST_MATCH_SINGLE,
      patterns: [operation.stackArtifactId],
    },
  });

  // PATTERN_MUST_MATCH_SINGLE throws when the pattern matches anything other
  // than one stack, so a missing result is not "no match": the Toolkit skips a
  // stack whose template has no resources, and *deletes* it if it already
  // exists. Both return normally, so reporting empty outputs here would call a
  // deletion a successful deploy. assertStackHasResources rejects the known way
  // into that state before we get here; this stays as the backstop for any other.
  if (result.stacks.length !== 1) {
    throw new AgentCoreCLIError(
      `The CDK Toolkit deployed no stack for '${operation.stackArtifactId}'. ` +
        `This happens when the synthesized stack has no resources, in which case an ` +
        `existing stack of that name is deleted rather than updated.`,
    );
  }

  // A stack that deployed but declares no outputs is legitimate. The stack ARN
  // is what the CLI persists to bind the target to this exact deployment.
  return { outputs: result.stacks[0]?.outputs ?? {}, stackArn: result.stacks[0]?.stackArn };
}

export function createCdkRunner(
  logger: Logger,
  load: CdkToolkitLoader = loadCdkToolkit,
): CdkRunner {
  const ioHost = createCdkIoHost(logger);
  return async (operation, options) => {
    const loaded = await load(ioHost, options.region, options.credentials);
    return performCdkOperation(loaded, operation, options);
  };
}
