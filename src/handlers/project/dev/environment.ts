import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { InputValidationError } from "../../../errors";

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

async function localEnvironment(
  projectRoot: string,
  read: (path: string, encoding: BufferEncoding) => Promise<string>,
): Promise<Record<string, string>> {
  const path = join(projectRoot, "agentcore", ".env.local");
  let contents: string;
  try {
    contents = await read(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new InputValidationError(`Unable to read local environment file at ${path}`, {
      cause: error,
    });
  }

  try {
    return parseEnv(contents) as Record<string, string>;
  } catch (error) {
    throw new InputValidationError(`Invalid local environment file at ${path}`, { cause: error });
  }
}

export function createDevEnvironmentLoader(
  config: DevEnvironmentLoaderConfig = {},
): DevEnvironmentLoader {
  const read = config.readFile ?? readFile;

  return async (input) => {
    const env = Object.fromEntries(
      (input.runtime.envVars ?? []).map(({ name, value }) => [name, value]),
    );
    if (input.region) env.AWS_REGION = input.region;

    Object.assign(env, await localEnvironment(input.projectRoot, read));
    for (const key of RESERVED_ENV_KEYS) delete env[key];

    return { env };
  };
}

export const loadDevEnvironment = createDevEnvironmentLoader();
