import { readCliConfig } from '../utils/cli-config';

/**
 * Return Docker --build-arg flags for UV index URLs configured in ~/.agentcore/config.json.
 * Returns an empty array when no custom indexes are configured.
 */
export function getUvBuildArgs(): string[] {
  const config = readCliConfig();
  const args: string[] = [];
  if (config.uvIndexUrl) args.push('--build-arg', `UV_INDEX_URL=${config.uvIndexUrl}`);
  if (config.uvExtraIndexUrl) args.push('--build-arg', `UV_EXTRA_INDEX_URL=${config.uvExtraIndexUrl}`);
  return args;
}
