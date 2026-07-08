import { readGlobalConfigSync } from '../schemas/io/global-config';

/**
 * Return Docker --build-arg flags for UV index URLs configured in ~/.agentcore/config.json.
 * Returns an empty array when no custom indexes are configured.
 */
export function getUvBuildArgs(): string[] {
  const config = readGlobalConfigSync();
  const args: string[] = [];
  if (config.uvDefaultIndex) args.push('--build-arg', `UV_DEFAULT_INDEX=${config.uvDefaultIndex}`);
  if (config.uvIndex) args.push('--build-arg', `UV_INDEX=${config.uvIndex}`);
  return args;
}

/**
 * Return Docker `--build-arg KEY=VALUE` flags for an agent's `customDockerBuildArgs`.
 * Returns an empty array when there are none. Shared by the local `package` and `dev` build paths
 * so the flag encoding stays in one place.
 */
export function getCustomBuildArgs(customDockerBuildArgs?: Record<string, string>): string[] {
  return Object.entries(customDockerBuildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
}
