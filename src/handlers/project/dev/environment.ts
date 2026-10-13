import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { readEnvFile } from "../../../io/envFile";

const RESERVED_ENV_KEYS = ["PORT", "FASTMCP_PORT", "LOCAL_DEV"] as const;

export type DevEnvironmentInput = {
  projectRoot: string;
  runtime: ProjectRuntime;
  region?: string;
  /** Discovery variables resolved from the selected deployment target. */
  deployedEnvironment?: Record<string, string>;
};

export type DevEnvironment = {
  env: Record<string, string>;
};

export type DevEnvironmentLoader = (input: DevEnvironmentInput) => Promise<DevEnvironment>;

type DevEnvironmentLoaderConfig = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
};

function supportsPayments(runtime: ProjectRuntime): boolean {
  if (runtime.protocol && runtime.protocol !== "HTTP") return false;
  return (runtime.entrypoint.split(":")[0] ?? "").endsWith(".py");
}

export function createDevEnvironmentLoader(
  config: DevEnvironmentLoaderConfig = {},
): DevEnvironmentLoader {
  return async (input) => {
    const env = Object.fromEntries(
      (input.runtime.envVars ?? []).map(({ name, value }) => [name, value]),
    );

    const deployedEnvironment = supportsPayments(input.runtime)
      ? input.deployedEnvironment
      : Object.fromEntries(
          Object.entries(input.deployedEnvironment ?? {}).filter(
            ([name]) => !name.startsWith("AGENTCORE_PAYMENT_"),
          ),
        );
    Object.assign(env, deployedEnvironment);
    Object.assign(
      env,
      await readEnvFile(join(input.projectRoot, "agentcore", ".env.local"), {
        ...config,
        select: (name) => !RESERVED_ENV_KEYS.some((reserved) => reserved === name),
      }),
    );
    if (input.region) {
      env.AWS_REGION = input.region;
      env.AWS_DEFAULT_REGION = input.region;
    }
    for (const key of RESERVED_ENV_KEYS) delete env[key];

    return { env };
  };
}

export const loadDevEnvironment = createDevEnvironmentLoader();
