import { ConfigIO, requireConfigRoot } from '../../../lib';
import { ValidationError } from '../../../lib/errors/types';
import type { DeployedResourceState, HarnessSpec } from '../../../schema';
import { DEFAULT_SYSTEM_PROMPT } from './constants';
import type { ResolvedHarnessContext } from './types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read and validate all on-disk inputs for the harness export.
 * Throws ValidationError for user-fixable problems.
 */
/**
 * A harness spec + system prompt fetched out-of-band (the `--arn` path), used instead of reading
 * a local in-project harness. When provided, the local harness-registry lookup and file reads are
 * skipped; the current project is still used for target validation, deployed state, and region.
 */
export interface PrefetchedHarness {
  spec: HarnessSpec;
  systemPrompt?: string;
}

export async function resolveHarnessContext(
  harnessName: string,
  targetAgentName: string,
  configBaseDir?: string,
  prefetched?: PrefetchedHarness
): Promise<ResolvedHarnessContext> {
  const baseDir = configBaseDir ?? requireConfigRoot();
  const configIO = new ConfigIO({ baseDir });
  const projectRoot = join(baseDir, '..');

  // 1. Read project spec. For a local harness, validate it is registered before any file I/O.
  const projectSpec = await configIO.readProjectSpec();

  if (!prefetched) {
    const harnessEntry = projectSpec.harnesses?.find(h => h.name === harnessName);
    if (!harnessEntry) {
      throw new ValidationError(
        `Harness "${harnessName}" not found in agentcore.json. Available harnesses: ${(projectSpec.harnesses ?? []).map(h => h.name).join(', ') || 'none'}`
      );
    }
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

  // 3 + 4. Resolve the harness spec and system prompt — from the fetched payload (`--arn`) or
  //        from local files (in-project harness).
  let spec: HarnessSpec;
  let systemPrompt: string;
  if (prefetched) {
    spec = prefetched.spec;
    const trimmedPrompt = prefetched.systemPrompt?.trim();
    const nonEmptyPrompt = trimmedPrompt && trimmedPrompt.length > 0 ? trimmedPrompt : undefined;
    systemPrompt = nonEmptyPrompt ?? prefetched.spec.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  } else {
    spec = await configIO.readHarnessSpec(harnessName);
    const harnessDir = join(projectRoot, 'app', harnessName);
    const systemPromptPath = join(harnessDir, 'system-prompt.md');
    if (existsSync(systemPromptPath)) {
      systemPrompt = readFileSync(systemPromptPath, 'utf8').trim();
    } else if (spec.systemPrompt) {
      systemPrompt = spec.systemPrompt;
    } else {
      systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
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
    localEnvVars: {},
    generatedPolicyFiles: {},
    additionalPolicies: [],
  };
}
