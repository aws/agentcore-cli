import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { readEnvFile } from "../../../io/envFile";

const RESERVED_ENV_KEYS = ["PORT", "FASTMCP_PORT", "LOCAL_DEV"] as const;

export type DevEnvironmentInput = {
  projectRoot: string;
  runtime: ProjectRuntime;
  region?: string;
};

export type DevEnvironment = {
  env: Record<string, string>;
};

export type DevEnvironmentLoader = (input: DevEnvironmentInput) => Promise<DevEnvironment>;

type DevEnvironmentLoaderConfig = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
};

export function createDevEnvironmentLoader(
  config: DevEnvironmentLoaderConfig = {},
): DevEnvironmentLoader {
  return async (input) => {
    const env = Object.fromEntries(
      (input.runtime.envVars ?? []).map(({ name, value }) => [name, value]),
    );
    if (input.region) env.AWS_REGION = input.region;

    Object.assign(
      env,
      await readEnvFile(join(input.projectRoot, "agentcore", ".env.local"), {
        ...config,
        select: (name) => !RESERVED_ENV_KEYS.some((reserved) => reserved === name),
      }),
    );
    for (const key of RESERVED_ENV_KEYS) delete env[key];

    return { env };
  };
}

export const loadDevEnvironment = createDevEnvironmentLoader();
