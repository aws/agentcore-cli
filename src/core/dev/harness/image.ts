import { setTimeout as sleep } from "node:timers/promises";
import { InputValidationError, InvalidEnvironmentError } from "../../../errors";
import type { ProcessStreamer, StreamProcessOptions } from "../../../io";
import { resolveContainerTool, type ContainerTool, type ToolAvailable } from "../container";
import { errorMessage } from "../inspector/respond";

const IMAGE_ALIASES: Record<string, string> = {
  "us-west-2": "y5s8y8h8",
  "us-east-1": "i0n3d3i5",
  "us-east-2": "f8y8k1i5",
  "eu-west-1": "i0v7l5a2",
  "ap-southeast-2": "y5n7p0r5",
};

export const HARNESS_PLATFORM = "linux/arm64";

export function harnessImage(region: string): string {
  const alias = IMAGE_ALIASES[region];
  if (!alias) {
    throw new InputValidationError(
      `Local harnesses are not available in ${region}. Supported regions: ${Object.keys(IMAGE_ALIASES).join(", ")}.`,
    );
  }
  return `public.ecr.aws/${alias}/harness-${region}:latest`;
}

type HarnessImagePull = {
  region: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  streamProcess: ProcessStreamer;
  toolAvailable: ToolAvailable;
  progressIntervalMs?: number;
};

export async function* pullHarnessImage(
  input: HarnessImagePull,
): AsyncGenerator<string, ContainerTool> {
  const { streamProcess, signal } = input;
  const options: StreamProcessOptions = { cwd: input.cwd, env: input.env, signal };
  const image = harnessImage(input.region);
  const tool = await resolveContainerTool(input.toolAvailable, signal);
  const cached = await imageDigest(streamProcess, tool, image, options);
  yield `Pulling ${image} with ${tool}${cached ? "" : ", first pull, about 1 GiB"}`;

  const command = [tool, "pull", "--quiet", "--platform", HARNESS_PLATFORM, image];
  const pulling = (async () => {
    for await (const _event of streamProcess(command, options)) {
    }
  })();
  const done = pulling.then(
    () => true,
    () => true,
  );
  const started = Date.now();
  while (
    !(await Promise.race([done, sleep(input.progressIntervalMs ?? 15_000, false, { ref: false })]))
  ) {
    yield `Still pulling (${Math.round((Date.now() - started) / 1000)} s)`;
  }
  try {
    await pulling;
  } catch (error) {
    signal.throwIfAborted();
    const detail = errorMessage(error);
    if (!cached) {
      throw new InvalidEnvironmentError(`Could not pull ${image}: ${detail}`, { cause: error });
    }
    yield `Could not pull ${image} (${detail}). Using the cached image ${cached}.`;
    return tool;
  }
  yield `Image ready (${await imageDigest(streamProcess, tool, image, options)})`;
  return tool;
}

async function imageDigest(
  streamProcess: ProcessStreamer,
  tool: ContainerTool,
  image: string,
  options: StreamProcessOptions,
): Promise<string | undefined> {
  try {
    let id: string | undefined;
    for await (const event of streamProcess(
      [tool, "image", "inspect", "--format", "{{.Id}}", image],
      options,
    )) {
      if (event.type === "stdout") id ??= event.line.trim() || undefined;
    }
    return id;
  } catch {
    return undefined;
  }
}
