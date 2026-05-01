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
