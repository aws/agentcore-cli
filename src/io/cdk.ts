// CDK operations driven in-process via @aws-cdk/toolkit-lib rather than by shelling out
// to `npx cdk`, so progress arrives as structured messages instead of scraped stdout.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  /** The synthesized cloud assembly to deploy from. Unused by bootstrap. */
  assemblyDirectory: string;
  /** Region for the toolkit's own SDK calls; each stack's environment comes from the assembly. */
  region: string;
};

/** Yields the toolkit's messages as they arrive. Injectable so tests never reach AWS. */
export type CdkRunner = (
  operation: CdkOperation,
  options: CdkRunOptions,
) => AsyncGenerator<CdkEvent, void>;

/** Narrowed to the methods actually called, so a test can stand in for the toolkit. */
export type CdkToolkit = Pick<Toolkit, "bootstrap" | "fromAssemblyDirectory" | "deploy">;

/** The parts of the toolkit package an operation needs, loaded on demand. */
export type CdkToolkitLib = Pick<
  typeof import("@aws-cdk/toolkit-lib"),
  | "BootstrapEnvironments"
  | "BootstrapSource"
  | "BootstrapStackParameters"
  | "StackSelectionStrategy"
>;

/** An embedded file, whose name Bun's types widen away on Bun.embeddedFiles. */
type NamedBlob = Blob & { readonly name: string };

const BOOTSTRAP_TEMPLATE = "bootstrap-template.yaml";

/** The files compiled into this executable, or none when running from source or a bundle. */
function embeddedFiles(): readonly NamedBlob[] {
  return typeof Bun === "undefined" ? [] : (Bun.embeddedFiles as readonly NamedBlob[]);
}

/**
 * Writes the embedded bootstrap template to a file the toolkit can read, or returns
 * undefined when it should read its own.
 *
 * The toolkit finds its bootstrap template relative to its own package directory. A
 * compiled executable has no node_modules, so the build embeds the template and points
 * bootstrap at a copy; everywhere else the package finds its own.
 */
export async function loadBootstrapTemplate(
  files: readonly NamedBlob[] = embeddedFiles(),
): Promise<string | undefined> {
  const template = files.find((file) => file.name.endsWith(BOOTSTRAP_TEMPLATE));
  if (!template) return undefined;

  const directory = await mkdtemp(join(tmpdir(), "agentcore-bootstrap-"));
  const path = join(directory, BOOTSTRAP_TEMPLATE);
  await writeFile(path, await template.text());
  return path;
}

/**
 * Loads the toolkit package and builds a toolkit that reports to `ioHost`.
 *
 * Imported here rather than at module scope: it is the CLI's heaviest dependency and
 * `src/io` is reachable from every command, so a static import would make even
 * `agentcore --help` pay to load a deploy it is not doing.
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

/**
 * Performs one operation, awaiting the toolkit call it maps to. `files` is taken as an
 * argument so a test can exercise the compiled executable's bootstrap path.
 */
export async function performCdkOperation(
  { lib, toolkit }: { lib: CdkToolkitLib; toolkit: CdkToolkit },
  operation: CdkOperation,
  options: CdkRunOptions,
  files: readonly NamedBlob[] = embeddedFiles(),
): Promise<void> {
  if (operation.kind === "bootstrap") {
    const template = await loadBootstrapTemplate(files);
    try {
      await toolkit.bootstrap(lib.BootstrapEnvironments.fromList(operation.environments), {
        // Provisions a customer-managed KMS key for the staging bucket, matching
        // the parameters the original CLI bootstraps with.
        parameters: lib.BootstrapStackParameters.withExisting({ createCustomerMasterKey: true }),
        ...(template && { source: lib.BootstrapSource.customTemplate(template) }),
      });
    } finally {
      if (template) await rm(dirname(template), { recursive: true, force: true });
    }
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
 * Bridges the toolkit's push-based reporting to a pull-based generator: `drive` runs to
 * completion while the caller drains the queue its messages land in. A failure
 * propagates only once that queue is empty, so the output explaining it comes first.
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
