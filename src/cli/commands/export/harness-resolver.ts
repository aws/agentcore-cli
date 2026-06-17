import { ConfigIO, requireConfigRoot } from '../../../lib';
import { ValidationError } from '../../../lib/errors/types';
import type { DeployedResourceState } from '../../../schema';
import { DEFAULT_SYSTEM_PROMPT } from './constants';
import type { ResolvedHarnessContext } from './types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read and validate all on-disk inputs for the harness export.
 * Throws ValidationError for user-fixable problems.
 */
export async function resolveHarnessContext(
  harnessName: string,
  targetAgentName: string,
  configBaseDir?: string
): Promise<ResolvedHarnessContext> {
  const baseDir = configBaseDir ?? requireConfigRoot();
  const configIO = new ConfigIO({ baseDir });
  const projectRoot = join(baseDir, '..');

  // 1. Read project spec and validate harness exists before any harness file I/O
  const projectSpec = await configIO.readProjectSpec();

  const harnessEntry = projectSpec.harnesses?.find(h => h.name === harnessName);
  if (!harnessEntry) {
    throw new ValidationError(
      `Harness "${harnessName}" not found in agentcore.json. Available harnesses: ${(projectSpec.harnesses ?? []).map(h => h.name).join(', ') || 'none'}`
    );
  }

  // 2. Validate target agent name not already taken
  if (projectSpec.runtimes.some(r => r.name === targetAgentName)) {
    throw new ValidationError(
      `A runtime agent named "${targetAgentName}" already exists. Choose a different --target-agent-name.`
    );
  }

  // 2b. Validate the target directory does not already exist on disk. A leftover directory
  //     (e.g. from a removed agent or a prior failed export) has no runtime entry, so the
  //     check above would pass and the render/copy would silently overwrite it.
  const targetAgentDir = join(projectRoot, 'app', targetAgentName);
  if (existsSync(targetAgentDir)) {
    throw new ValidationError(
      `The directory "app/${targetAgentName}/" already exists. Remove it or choose a different --target-agent-name.`
    );
  }

  // 3. Read harness spec
  const spec = await configIO.readHarnessSpec(harnessName);

  // 4. Read system prompt — harness app files live in projectRoot/app/<name>/
  const harnessDir = join(projectRoot, 'app', harnessName);
  const systemPromptPath = join(harnessDir, 'system-prompt.md');
  let systemPrompt: string;
  if (existsSync(systemPromptPath)) {
    systemPrompt = readFileSync(systemPromptPath, 'utf8').trim();
  } else if (spec.systemPrompt) {
    systemPrompt = spec.systemPrompt;
  } else {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  // 5. Read deployed state (optional — absent before first deploy)
  let deployedResources: DeployedResourceState | null = null;
  let region: string | undefined;
  try {
    const deployedState = await configIO.readDeployedState();
    // Use the first target's resources (there is only one target per project)
    const firstTarget = Object.values(deployedState.targets)[0];
    deployedResources = firstTarget?.resources ?? null;
  } catch {
    // File absent or unreadable — proceed without it
  }

  try {
    const targets = await configIO.readAWSDeploymentTargets();
    region = targets[0]?.region;
  } catch {
    // No targets configured yet
  }

  return {
    harnessName,
    targetAgentName,
    spec,
    systemPrompt,
    projectSpec,
    deployedResources,
    configBaseDir: baseDir,
    projectRoot,
    exportNotes: [],
    region,
  };
}
