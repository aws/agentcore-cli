/**
 * HarnessDeployer - Post-CDK imperative deployer for Harness resources.
 *
 * Runs after CDK deploy to create, update, or delete harness resources
 * via the SigV4 API client. Harness role ARNs are resolved from CDK
 * stack outputs, and harness specs are read from disk (harness.json).
 */
import type { HarnessDeployedState, HarnessSpec } from '../../../../../schema';
import { HarnessSpecSchema } from '../../../../../schema';
import type {
  CreateHarnessResult,
  Harness,
  UpdateHarnessOptions,
  UpdateHarnessResult,
} from '../../../../aws/agentcore-harness';
import { createHarness, deleteHarness, getHarness, updateHarness } from '../../../../aws/agentcore-harness';
import { AgentCoreApiError } from '../../../../aws/api-client';
import { toPascalId } from '../../../../cloudformation/logical-ids';
import type { DeployPhase, ImperativeDeployContext, ImperativeDeployResult, ImperativeDeployer } from '../types';
import { mapHarnessSpecToCreateOptions } from './harness-mapper';
import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'path';

const ROLE_VALIDATION_RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 30_000];
const READY_POLL_INTERVAL_MS = 3_000;
const READY_POLL_MAX_ATTEMPTS = 40; // 2 minutes max

// ============================================================================
// Types
// ============================================================================

type HarnessDeployedStateMap = Record<string, HarnessDeployedState>;

async function computeHarnessHash(harnessDir: string, harnessSpec: HarnessSpec, roleArn: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(harnessSpec));
  hash.update(roleArn);
  try {
    const promptContent = await readFile(join(harnessDir, 'system-prompt.md'), 'utf-8');
    hash.update(promptContent);
  } catch {
    // no system-prompt.md
  }
  if (harnessSpec.dockerfile) {
    try {
      const dockerfileContent = await readFile(join(harnessDir, harnessSpec.dockerfile), 'utf-8');
      hash.update(dockerfileContent);
    } catch {
      // Dockerfile missing — preflight already validates existence before deploy
    }
  }
  return hash.digest('hex').slice(0, 16);
}

// ============================================================================
// Deployer
// ============================================================================

export class HarnessDeployer implements ImperativeDeployer<HarnessDeployedStateMap> {
  readonly name = 'harness';
  readonly label = 'Harnesses';
  readonly phase: DeployPhase = 'post-cdk';

  shouldRun(context: ImperativeDeployContext): boolean {
    const projectHarnesses = context.projectSpec.harnesses;
    const hasProjectHarnesses = !!projectHarnesses && projectHarnesses.length > 0;

    const targetName = context.target.name;
    const deployedHarnesses = context.deployedState.targets?.[targetName]?.resources?.harnesses;
    const hasDeployedHarnesses = !!deployedHarnesses && Object.keys(deployedHarnesses).length > 0;

    return hasProjectHarnesses || hasDeployedHarnesses;
  }

  async deploy(context: ImperativeDeployContext): Promise<ImperativeDeployResult<HarnessDeployedStateMap>> {
    const { projectSpec, target, configIO, deployedState, cdkOutputs } = context;
    const region = target.region;
    const targetName = target.name;
    const projectName = projectSpec.name;
    const configRoot = configIO.getConfigRoot();
    const projectRoot = dirname(configRoot);

    const projectHarnesses = projectSpec.harnesses ?? [];
    const deployedHarnesses = deployedState.targets?.[targetName]?.resources?.harnesses ?? {};
    const resultState: HarnessDeployedStateMap = { ...deployedHarnesses };
    const notes: string[] = [];

    // Build set of harness names in current project spec
    const projectHarnessNames = new Set(projectHarnesses.map(h => h.name));

    // Create or update each harness in the project spec
    for (const entry of projectHarnesses) {
      // Harness path is relative to project root (like agent codeLocation)
      const harnessDir = join(projectRoot, entry.path);

      // Read harness.json from disk and validate
      let harnessSpec: HarnessSpec;
      try {
        const raw = await readFile(join(harnessDir, 'harness.json'), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const validated = HarnessSpecSchema.safeParse(parsed);
        if (!validated.success) {
          return {
            success: false,
            error: `Invalid harness.json for "${entry.name}": ${validated.error.message}`,
            state: resultState,
          };
        }
        harnessSpec = validated.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Failed to read harness.json for "${entry.name}": ${message}`,
          state: resultState,
        };
      }

      // Resolve role ARN from CDK outputs
      const roleArn = resolveRoleArn(entry.name, cdkOutputs);
      if (!roleArn) {
        return {
          success: false,
          error: `Could not find role ARN in CDK outputs for harness "${entry.name}". Expected output key starting with "ApplicationHarness${toPascalId(entry.name)}RoleArn" or "ApplicationHarness${toPascalId(entry.name)}RoleRoleArn".`,
          state: resultState,
        };
      }

      // Use executionRoleArn from harness spec if provided, otherwise use CDK output
      const executionRoleArn = harnessSpec.executionRoleArn ?? roleArn;

      const deployedResources = deployedState.targets?.[targetName]?.resources;
      const existingHarness = deployedHarnesses[entry.name];

      const configHash = await computeHarnessHash(harnessDir, harnessSpec, executionRoleArn);

      if (existingHarness?.configHash === configHash) {
        resultState[entry.name] = existingHarness;
        notes.push(`Harness "${entry.name}" unchanged, skipped`);
        context.onProgress?.(`Harness "${entry.name}": no changes`, 'done');
        continue;
      }

      try {
        if (existingHarness) {
          // Update existing harness
          const createOptions = await mapHarnessSpecToCreateOptions({
            harnessSpec,
            harnessDir,
            executionRoleArn,
            region,
            projectName,
            deployedResources,
            cdkOutputs,
          });

          // Memory uses { optionalValue: null } to explicitly clear it when removed from config,
          // since the API treats an absent field as "no change" but null as "remove".
          // environmentArtifact uses undefined (omit) because container config is immutable
          // after creation — it cannot be cleared via update, only set on create.
          const updateOptions: UpdateHarnessOptions = {
            region,
            harnessId: existingHarness.harnessId,
            executionRoleArn: createOptions.executionRoleArn,
            model: createOptions.model,
            systemPrompt: createOptions.systemPrompt,
            tools: createOptions.tools,
            skills: createOptions.skills,
            allowedTools: createOptions.allowedTools,
            memory: createOptions.memory ? { optionalValue: createOptions.memory } : { optionalValue: null },
            truncation: createOptions.truncation,
            maxIterations: createOptions.maxIterations,
            maxTokens: createOptions.maxTokens,
            timeoutSeconds: createOptions.timeoutSeconds,
            environment: createOptions.environment,
            environmentArtifact: createOptions.environmentArtifact
              ? { optionalValue: createOptions.environmentArtifact }
              : undefined,
            environmentVariables: createOptions.environmentVariables,
            tags: createOptions.tags,
            authorizerConfiguration: createOptions.authorizerConfiguration
              ? { optionalValue: createOptions.authorizerConfiguration }
              : { optionalValue: null },
          };

          const updateResult: UpdateHarnessResult = await updateHarness(updateOptions);
          const finalHarness = await waitForReady(region, updateResult.harness);
          resultState[entry.name] = {
            harnessId: finalHarness.harnessId,
            harnessArn: finalHarness.arn,
            roleArn: executionRoleArn,
            status: finalHarness.status,
            agentRuntimeArn: extractRuntimeArn(finalHarness),
            memoryArn: createOptions.memory?.memoryArn,
            configHash,
          };
          notes.push(`Updated harness "${entry.name}"`);
        } else {
          // Create new harness (with retry for IAM role propagation delay)
          const createOptions = await mapHarnessSpecToCreateOptions({
            harnessSpec,
            harnessDir,
            executionRoleArn,
            region,
            projectName,
            deployedResources,
            cdkOutputs,
          });

          const createResult: CreateHarnessResult = await createWithRetry(createOptions);
          const finalHarness = await waitForReady(region, createResult.harness);
          resultState[entry.name] = {
            harnessId: finalHarness.harnessId,
            harnessArn: finalHarness.arn,
            roleArn: executionRoleArn,
            status: finalHarness.status,
            agentRuntimeArn: extractRuntimeArn(finalHarness),
            memoryArn: createOptions.memory?.memoryArn,
            configHash,
          };
          notes.push(`Created harness "${entry.name}"`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hint = getDeployErrorHint(err, region);
        const errorMsg = hint
          ? `Failed to deploy harness "${entry.name}": ${message}\n${hint}`
          : `Failed to deploy harness "${entry.name}": ${message}`;
        return { success: false, error: errorMsg, state: resultState };
      }
    }

    // Delete harnesses that exist in deployed state but not in project spec
    for (const [name, state] of Object.entries(deployedHarnesses)) {
      if (!projectHarnessNames.has(name)) {
        try {
          await deleteHarness({ region, harnessId: state.harnessId });
          delete resultState[name];
          notes.push(`Deleted harness "${name}"`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Failed to delete harness "${name}": ${message}`, state: resultState };
        }
      }
    }

    return { success: true, state: resultState, notes };
  }

  async teardown(context: ImperativeDeployContext): Promise<ImperativeDeployResult<HarnessDeployedStateMap>> {
    const { target, deployedState } = context;
    const region = target.region;
    const targetName = target.name;

    const deployedHarnesses = deployedState.targets?.[targetName]?.resources?.harnesses ?? {};
    const notes: string[] = [];

    for (const [name, state] of Object.entries(deployedHarnesses)) {
      try {
        await deleteHarness({ region, harnessId: state.harnessId });
        notes.push(`Deleted harness "${name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to delete harness "${name}": ${message}` };
      }
    }

    return { success: true, state: {}, notes };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the IAM role ARN for a harness from CDK stack outputs.
 *
 * Supports two construct tree layouts:
 *   Old (AgentCoreHarnessRole directly under Application):
 *     ApplicationHarness{PascalName}RoleArnOutput...
 *   New (AgentCoreHarnessEnvironment wrapping AgentCoreHarnessRole):
 *     ApplicationHarness{PascalName}RoleRoleArnOutput...
 */
function resolveRoleArn(harnessName: string, cdkOutputs?: Record<string, string>): string | undefined {
  if (!cdkOutputs) return undefined;

  const pascalName = toPascalId(harnessName);
  // Longer prefix first — RoleArn is a substring of RoleRoleArn, so checking it first would match both.
  const prefixes = [`ApplicationHarness${pascalName}RoleRoleArn`, `ApplicationHarness${pascalName}RoleArn`];

  for (const [key, value] of Object.entries(cdkOutputs)) {
    if (prefixes.some(p => key.startsWith(p))) {
      return value;
    }
  }

  return undefined;
}

function isRoleValidationError(err: unknown): boolean {
  return err instanceof AgentCoreApiError && err.statusCode === 400 && err.errorBody.includes('Role validation failed');
}

async function createWithRetry(options: Parameters<typeof createHarness>[0]): Promise<CreateHarnessResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ROLE_VALIDATION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await createHarness(options);
    } catch (err) {
      if (!isRoleValidationError(err) || attempt === ROLE_VALIDATION_RETRY_DELAYS_MS.length) {
        throw err;
      }
      lastError = err;
      await sleep(ROLE_VALIDATION_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError;
}

async function waitForReady(region: string, harness: Harness): Promise<Harness> {
  if (harness.status === 'READY' || harness.status === 'FAILED') return harness;

  for (let i = 0; i < READY_POLL_MAX_ATTEMPTS; i++) {
    await sleep(READY_POLL_INTERVAL_MS);
    const result = await getHarness({ region, harnessId: harness.harnessId });
    if (result.harness.status === 'READY' || result.harness.status === 'FAILED') return result.harness;
  }

  return harness;
}

function extractRuntimeArn(harness: Harness): string | undefined {
  return harness.environment?.agentCoreRuntimeEnvironment?.agentRuntimeArn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDeployErrorHint(err: unknown, region: string): string | undefined {
  if (!(err instanceof AgentCoreApiError)) return undefined;
  const body = err.errorBody.toLowerCase();

  if (err.statusCode === 403) {
    return 'Check that your AWS credentials have permission to call the AgentCore Harness API.';
  }
  if (body.includes('not available') || body.includes('not supported') || body.includes('endpoint')) {
    return `Harness may not be available in ${region}. Try a different region (e.g., us-east-1, us-west-2).`;
  }
  if (err.statusCode === 429) {
    return 'Too many requests. Wait a moment and try again.';
  }
  if (err.statusCode >= 500) {
    return 'This looks like a service-side issue. Wait a moment and redeploy.';
  }
  return undefined;
}
