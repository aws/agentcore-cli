import type { ABTestDeployedState, AgentCoreProjectSpec, DeployedResourceState } from '../../../schema';
import { getCredentialProvider } from '../../aws/account';
import { createABTest, deleteABTest, getABTest, listABTests, updateABTest } from '../../aws/agentcore-ab-tests';
import type { ABTestEvaluationConfig, ABTestVariant, TrafficAllocationConfig } from '../../aws/agentcore-ab-tests';
import { arnPrefix } from '../../aws/partition';
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { createHash } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface SetupABTestsOptions {
  region: string;
  projectSpec: AgentCoreProjectSpec;
  existingABTests?: Record<string, ABTestDeployedState>;
  /** Full deployed resource state for resolving ARN references. */
  deployedResources?: DeployedResourceState;
}

export interface ABTestSetupResult {
  testName: string;
  status: 'created' | 'updated' | 'deleted' | 'skipped' | 'error';
  abTestId?: string;
  abTestArn?: string;
  error?: string;
  warning?: string;
}

export interface SetupABTestsResult {
  results: ABTestSetupResult[];
  abTests: Record<string, ABTestDeployedState>;
  hasErrors: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const AB_TEST_ROLE_POLICY_NAME = 'ABTestExecutionPolicy';

// ============================================================================
// Config Hash
// ============================================================================

/**
 * Compute a deterministic SHA-256 hash of the key AB test configuration fields.
 * Used to detect whether a redeployment actually changed the test config.
 */
function computeConfigHash(testSpec: {
  variants: unknown;
  evaluationConfig: unknown;
  gatewayRef: string;
  gatewayFilter?: unknown;
  trafficAllocationConfig?: unknown;
}): string {
  const payload = JSON.stringify({
    variants: testSpec.variants,
    evaluationConfig: testSpec.evaluationConfig,
    gatewayRef: testSpec.gatewayRef,
    gatewayFilter: testSpec.gatewayFilter,
    trafficAllocationConfig: testSpec.trafficAllocationConfig,
  });
  return createHash('sha256').update(payload).digest('hex');
}

// ============================================================================
// Shared Update Helper
// ============================================================================

interface ApplyABTestUpdateOptions {
  region: string;
  abTestId: string;
  resolvedVariants: ABTestVariant[];
  resolvedEvalConfig: ABTestEvaluationConfig;
  trafficAllocationConfig?: TrafficAllocationConfig;
  resolvedRoleArn?: string;
  testName: string;
  roleCreatedByCli: boolean;
  currentHash: string;
}

async function applyABTestUpdate(
  options: ApplyABTestUpdateOptions
): Promise<{ state: ABTestDeployedState; result: ABTestSetupResult }> {
  const updateResult = await updateABTest({
    region: options.region,
    abTestId: options.abTestId,
    variants: options.resolvedVariants,
    evaluationConfig: options.resolvedEvalConfig,
    trafficAllocationConfig: options.trafficAllocationConfig,
    roleArn: options.resolvedRoleArn,
  });

  return {
    state: {
      abTestId: updateResult.abTestId,
      abTestArn: updateResult.abTestArn,
      roleArn: options.resolvedRoleArn,
      roleCreatedByCli: options.roleCreatedByCli,
      configHash: options.currentHash,
    },
    result: {
      testName: options.testName,
      status: 'updated',
      abTestId: updateResult.abTestId,
      abTestArn: updateResult.abTestArn,
    },
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create, update, or delete AB tests post-deploy.
 *
 * Pattern:
 * 1. For each AB test in project spec → resolve ARN references, create or skip
 * 2. For each AB test in deployed-state but NOT in project spec → delete (reconciliation)
 * 3. Return updated deployed state entries
 */
export async function setupABTests(options: SetupABTestsOptions): Promise<SetupABTestsResult> {
  const { region, projectSpec, existingABTests, deployedResources } = options;
  const results: ABTestSetupResult[] = [];
  const abTests: Record<string, ABTestDeployedState> = {};

  // Create or skip tests from the spec
  for (const testSpec of projectSpec.abTests ?? []) {
    let resolvedRoleArn: string | undefined;
    let roleCreatedByCli = false;
    try {
      const currentHash = computeConfigHash(testSpec);
      const existingTest = existingABTests?.[testSpec.name];

      // Resolve ARN references from deployed state
      const resolvedVariants = resolveVariants(testSpec.variants, projectSpec.name, deployedResources);
      const resolvedGatewayArn = resolveGatewayArn(testSpec.gatewayRef, deployedResources);
      if (!resolvedGatewayArn.startsWith('arn:') || resolvedGatewayArn.split(':').length < 6) {
        results.push({
          testName: testSpec.name,
          status: 'error',
          error: `Gateway ARN could not be resolved for AB test "${testSpec.name}". Reference "${testSpec.gatewayRef}" did not match any deployed gateway. Ensure the HTTP gateway was deployed successfully.`,
        });
        continue;
      }
      const resolvedEvalConfig = resolveEvalConfig(testSpec.evaluationConfig, deployedResources);
      if (testSpec.roleArn) {
        resolvedRoleArn = testSpec.roleArn;
      } else {
        resolvedRoleArn = await getOrCreateABTestRole({
          region,
          projectName: projectSpec.name,
          testName: testSpec.name,
          gatewayArn: resolvedGatewayArn,
        });
        roleCreatedByCli = true;
      }

      if (existingTest) {
        // Config unchanged — skip to preserve running state
        if (existingTest.configHash === currentHash) {
          abTests[testSpec.name] = existingTest;
          results.push({
            testName: testSpec.name,
            status: 'skipped',
            abTestId: existingTest.abTestId,
            abTestArn: existingTest.abTestArn,
          });
          continue;
        }

        // Config changed — update in-place instead of delete+recreate
        const applied = await applyABTestUpdate({
          region,
          abTestId: existingTest.abTestId,
          resolvedVariants,
          resolvedEvalConfig,
          trafficAllocationConfig: testSpec.trafficAllocationConfig as TrafficAllocationConfig | undefined,
          resolvedRoleArn,
          testName: testSpec.name,
          roleCreatedByCli: existingTest.roleCreatedByCli ?? roleCreatedByCli,
          currentHash,
        });
        abTests[testSpec.name] = applied.state;
        results.push(applied.result);
        continue;
      }

      // Try to find by name via list (handles re-creation after state loss)
      const existingByName = await findABTestByName(region, projectSpec.name, testSpec.name);
      if (existingByName) {
        // Found by name — update in-place with fresh config
        const applied = await applyABTestUpdate({
          region,
          abTestId: existingByName.abTestId,
          resolvedVariants,
          resolvedEvalConfig,
          trafficAllocationConfig: testSpec.trafficAllocationConfig as TrafficAllocationConfig | undefined,
          resolvedRoleArn,
          testName: testSpec.name,
          roleCreatedByCli,
          currentHash,
        });
        abTests[testSpec.name] = applied.state;
        results.push(applied.result);
        continue;
      }

      const createOptions = {
        region,
        name: `${projectSpec.name}_${testSpec.name}`,
        description: testSpec.description,
        gatewayArn: resolvedGatewayArn,
        roleArn: resolvedRoleArn,
        variants: resolvedVariants,
        evaluationConfig: resolvedEvalConfig,
        gatewayFilter: testSpec.gatewayFilter,
        trafficAllocationConfig: testSpec.trafficAllocationConfig as TrafficAllocationConfig | undefined,
        maxDurationDays: testSpec.maxDurationDays,
        enableOnCreate: testSpec.enableOnCreate,
      };

      // Retry on gateway/eval access denied — IAM policy propagation can take time
      let result;
      const MAX_RETRIES = 5;
      const BASE_DELAY_MS = 5_000;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          result = await createABTest(createOptions);
          break;
        } catch (err: unknown) {
          const errCode = (err as { name?: string }).name;
          const errStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
          const msg = err instanceof Error ? err.message : String(err);

          const isRetryable =
            errCode === 'AccessDeniedException' ||
            errStatus === 403 ||
            msg.includes('Access denied') ||
            msg.includes('Gateway validation error');

          if (isRetryable && attempt < MAX_RETRIES - 1) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
      if (!result) throw new Error('AB test creation failed after retries');

      abTests[testSpec.name] = {
        abTestId: result.abTestId,
        abTestArn: result.abTestArn,
        roleArn: resolvedRoleArn,
        roleCreatedByCli,
        configHash: currentHash,
      };

      results.push({
        testName: testSpec.name,
        status: 'created',
        abTestId: result.abTestId,
        abTestArn: result.abTestArn,
      });
    } catch (err) {
      // Clean up auto-created role on AB test creation failure to avoid orphaned roles
      if (roleCreatedByCli && resolvedRoleArn) {
        try {
          await deleteABTestRole(region, resolvedRoleArn);
        } catch {
          // Best-effort role cleanup
        }
      }
      results.push({
        testName: testSpec.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orphaned AB tests are deleted by deleteOrphanedABTests() which runs
  // as a separate pre-pass before HTTP gateway setup. No deletion loop here.

  return {
    results,
    abTests,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

/**
 * Delete orphaned AB tests (in deployed-state but removed from spec).
 *
 * AB tests create rules on HTTP gateways, so they must be deleted before
 * the gateway can be deleted. Call this before setupHttpGateways.
 *
 * The main setupABTests deletion loop becomes a no-op for any tests
 * already cleaned up here.
 */
export async function deleteOrphanedABTests(options: {
  region: string;
  projectSpec: AgentCoreProjectSpec;
  existingABTests?: Record<string, ABTestDeployedState>;
}): Promise<{ results: ABTestSetupResult[]; hasErrors: boolean }> {
  const { region, projectSpec, existingABTests } = options;
  if (!existingABTests) return { results: [], hasErrors: false };

  const specTestNames = new Set((projectSpec.abTests ?? []).map(t => t.name));
  const results: ABTestSetupResult[] = [];

  for (const [testName, testState] of Object.entries(existingABTests)) {
    if (!specTestNames.has(testName)) {
      try {
        // Stop the AB test first — running tests cannot be deleted
        let wasStopped = false;
        let stopTimedOut = false;
        try {
          await updateABTest({ region, abTestId: testState.abTestId, executionStatus: 'STOPPED' });
          wasStopped = true;

          // Poll until executionStatus is STOPPED (stop is async)
          let stopped = false;
          for (let i = 0; i < 20; i++) {
            const test = await getABTest({ region, abTestId: testState.abTestId });
            if (test.executionStatus === 'STOPPED') {
              stopped = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 3_000));
          }
          if (!stopped) {
            stopTimedOut = true;
          }
        } catch {
          // May already be stopped or in a state that doesn't need stopping — proceed with delete
        }

        const deleteResult = await deleteABTest({
          region,
          abTestId: testState.abTestId,
        });

        if (deleteResult.success && testState.roleCreatedByCli && testState.roleArn) {
          await deleteABTestRole(region, testState.roleArn);
        }

        results.push({
          testName,
          status: deleteResult.success ? 'deleted' : 'error',
          error: deleteResult.error,
          warning: stopTimedOut
            ? `AB test "${testName}" did not reach STOPPED status within the polling window — proceeding with delete`
            : wasStopped
              ? `AB test "${testName}" was stopped before deletion`
              : undefined,
        });
      } catch (err) {
        results.push({
          testName,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

// ============================================================================
// ARN Resolution Helpers
// ============================================================================

async function findABTestByName(
  region: string,
  projectName: string,
  testName: string
): Promise<{ abTestId: string; abTestArn: string } | undefined> {
  try {
    const prefixedName = `${projectName}_${testName}`;
    const result = await listABTests({ region, maxResults: 100 });
    return result.abTests.find(
      t => t.name.toLowerCase() === prefixedName.toLowerCase() || t.name.toLowerCase() === testName.toLowerCase()
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolve variant config bundle references.
 * If bundleArn is a name (not an ARN), look it up in deployed config bundles.
 * Target-based variants have their target name prefixed with projectName to match
 * what post-deploy-http-gateways.ts creates on AWS (e.g. `${projectName}-${tgt.name}`).
 */
function resolveVariants(
  variants: {
    name: 'C' | 'T1';
    weight: number;
    variantConfiguration: {
      configurationBundle?: { bundleArn: string; bundleVersion: string };
      target?: { targetName: string };
    };
  }[],
  projectName: string,
  deployedResources?: DeployedResourceState
): ABTestVariant[] {
  return variants.map(v => {
    const bundle = v.variantConfiguration.configurationBundle;
    if (bundle) {
      return {
        name: v.name,
        weight: v.weight,
        variantConfiguration: {
          configurationBundle: {
            bundleArn: resolveConfigBundleArn(bundle.bundleArn, deployedResources),
            bundleVersion: resolveConfigBundleVersion(bundle.bundleArn, bundle.bundleVersion, deployedResources),
          },
        },
      };
    }
    // Target-based variant — prepend projectName to match the AWS-side name created by
    // post-deploy-http-gateways.ts: `${projectName}-${tgt.name}`
    return {
      name: v.name,
      weight: v.weight,
      variantConfiguration: {
        ...(v.variantConfiguration.target && {
          target: { name: resolveTargetName(v.variantConfiguration.target.targetName, projectName) },
        }),
      },
    };
  });
}

function resolveConfigBundleArn(ref: string, deployedResources?: DeployedResourceState): string {
  if (ref.startsWith('arn:')) return ref;

  const bundles = deployedResources?.configBundles;
  if (bundles?.[ref]) {
    return bundles[ref].bundleArn;
  }

  return ref;
}

function resolveConfigBundleVersion(
  bundleRef: string,
  versionRef: string,
  deployedResources?: DeployedResourceState
): string {
  if (versionRef !== 'LATEST') return versionRef;

  // Resolve LATEST to the deployed versionId
  const bundles = deployedResources?.configBundles;
  const name = bundleRef.startsWith('arn:') ? undefined : bundleRef;
  if (name && bundles?.[name]) {
    return bundles[name].versionId;
  }

  return versionRef;
}

/**
 * Resolve a variant target name, applying the project prefix if not already present.
 * This handles legacy configs that were created before the prefix requirement.
 */
function resolveTargetName(targetName: string, projectName: string): string {
  // If the target name already starts with the project prefix, use as-is to avoid double-prefixing
  if (targetName.startsWith(`${projectName}-`)) {
    return targetName;
  }
  return `${projectName}-${targetName}`;
}

function resolveGatewayArn(ref: string, deployedResources?: DeployedResourceState): string {
  if (ref.startsWith('arn:')) return ref;

  // Check for placeholder pattern {{gateway:<name>}}
  const placeholderMatch = /^\{\{gateway:(.+)\}\}$/.exec(ref);
  const gwName = placeholderMatch ? placeholderMatch[1] : ref;

  const gateways = deployedResources?.mcp?.gateways;
  if (gateways && gwName && gateways[gwName]) {
    return gateways[gwName].gatewayArn;
  }

  // Check HTTP gateways (imperatively created for A/B testing)
  const httpGateways = deployedResources?.httpGateways;
  if (httpGateways && gwName && httpGateways[gwName]) {
    return httpGateways[gwName].gatewayArn;
  }

  return ref;
}

function resolveEvalConfig(
  config:
    | { onlineEvaluationConfigArn: string }
    | { perVariantOnlineEvaluationConfig: { treatmentName: 'C' | 'T1'; onlineEvaluationConfigArn: string }[] },
  deployedResources?: DeployedResourceState
): ABTestEvaluationConfig {
  if ('perVariantOnlineEvaluationConfig' in config) {
    // Per-variant eval config — resolve each ARN
    return {
      perVariantOnlineEvaluationConfig: config.perVariantOnlineEvaluationConfig.map(pv => ({
        name: pv.treatmentName,
        onlineEvaluationConfigArn: resolveOnlineEvalArn(pv.onlineEvaluationConfigArn, deployedResources),
      })),
    };
  }

  const ref = config.onlineEvaluationConfigArn;
  return { onlineEvaluationConfigArn: resolveOnlineEvalArn(ref, deployedResources) };
}

function resolveOnlineEvalArn(ref: string, deployedResources?: DeployedResourceState): string {
  if (ref.startsWith('arn:')) return ref;

  const configs = deployedResources?.onlineEvalConfigs;
  if (configs?.[ref]) {
    return configs[ref].onlineEvaluationConfigArn;
  }

  return ref;
}

// ============================================================================
// IAM Role Management
// ============================================================================

/**
 * Generate a project-scoped role name following the CDK pattern:
 * AgentCore-{ProjectName}-ABTest{TestName}-{Hash}
 */
function generateRoleName(projectName: string, testName: string): string {
  // Deterministic hash so retries produce the same role name (avoids orphaned roles)
  const hash = createHash('sha256').update(`${projectName}:${testName}`).digest('hex').slice(0, 8);
  const base = `AgentCore-${projectName}-ABTest${testName}`;
  // IAM role names max 64 chars
  return `${base.slice(0, 55)}-${hash}`;
}

/**
 * Extract role name from ARN: arn:aws:iam::123456789012:role/RoleName → RoleName
 */
function roleNameFromArn(roleArn: string): string {
  const parts = roleArn.split('/');
  return parts[parts.length - 1] ?? roleArn;
}

interface CreateABTestRoleOptions {
  region: string;
  projectName: string;
  testName: string;
  gatewayArn: string;
}

async function getOrCreateABTestRole(options: CreateABTestRoleOptions): Promise<string> {
  const { region, projectName, testName, gatewayArn } = options;
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });

  // Extract account ID from gateway ARN (arn:aws:bedrock-agentcore:REGION:ACCOUNT:gateway/ID)
  const accountId = gatewayArn.split(':')[4] ?? '*';

  const roleName = generateRoleName(projectName, testName);

  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': accountId },
          ArnLike: { 'aws:SourceArn': `${arnPrefix(region)}:bedrock-agentcore:*:${accountId}:ab-test/*` },
        },
      },
    ],
  });

  let roleArn: string;
  let _needsPropagationWait = false;

  try {
    const createResult = await iamClient.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy,
        Description: `Auto-created execution role for AgentCore AB test: ${testName}`,
        Tags: [
          { Key: 'agentcore:created-by', Value: 'agentcore-cli' },
          { Key: 'agentcore:project-name', Value: projectName },
          { Key: 'agentcore:ab-test-name', Value: testName },
        ],
      })
    );

    roleArn = createResult.Role?.Arn ?? '';
    if (!roleArn) {
      throw new Error(`IAM CreateRole succeeded but returned no role ARN for "${roleName}"`);
    }
    _needsPropagationWait = true;
  } catch (err: unknown) {
    // Handle retry after a previous failed deploy left the role behind
    const errName = (err as { name?: string }).name;
    if (errName === 'EntityAlreadyExistsException') {
      // IAM role already exists — reuse it
      const existing = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      roleArn = existing.Role?.Arn ?? '';
      if (!roleArn) {
        throw new Error(`Role "${roleName}" already exists but ARN could not be retrieved`);
      }
    } else {
      throw err;
    }
  }

  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AgentCoreResources',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:GetGateway',
          'bedrock-agentcore:GetGatewayTarget',
          'bedrock-agentcore:ListGatewayTargets',
          'bedrock-agentcore:CreateGatewayRule',
          'bedrock-agentcore:UpdateGatewayRule',
          'bedrock-agentcore:GetGatewayRule',
          'bedrock-agentcore:DeleteGatewayRule',
          'bedrock-agentcore:ListGatewayRules',
          'bedrock-agentcore:GetOnlineEvaluationConfig',
          'bedrock-agentcore:GetEvaluator',
          'bedrock-agentcore:GetConfigurationBundle',
          'bedrock-agentcore:GetConfigurationBundleVersion',
          'bedrock-agentcore:ListConfigurationBundleVersions',
        ],
        Resource: `${arnPrefix(region)}:bedrock-agentcore:*:${accountId}:*`,
        Condition: { StringEquals: { 'aws:ResourceAccount': accountId } },
      },
      {
        Sid: 'CloudWatchLogsDescribe',
        Effect: 'Allow',
        Action: ['logs:DescribeLogGroups'],
        Resource: '*',
      },
      {
        Sid: 'CloudWatchLogs',
        Effect: 'Allow',
        Action: [
          'logs:DescribeIndexPolicies',
          'logs:PutIndexPolicy',
          'logs:StartQuery',
          'logs:GetQueryResults',
          'logs:StopQuery',
          'logs:FilterLogEvents',
          'logs:GetLogEvents',
        ],
        Resource: [
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:/aws/bedrock-agentcore/evaluations/*`,
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:aws/spans`,
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:aws/spans:*`,
        ],
      },
    ],
  });

  // Re-apply the inline policy (idempotent — covers both new and recovered roles)
  await iamClient.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: AB_TEST_ROLE_POLICY_NAME,
      PolicyDocument: policy,
    })
  );

  // Always wait for IAM policy propagation — both new roles and policy updates on existing roles
  await new Promise(resolve => setTimeout(resolve, 15_000));

  return roleArn;
}

async function deleteABTestRole(region: string, roleArn: string): Promise<void> {
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });
  const roleName = roleNameFromArn(roleArn);

  try {
    // Must delete inline policies before deleting the role
    await iamClient.send(
      new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: AB_TEST_ROLE_POLICY_NAME,
      })
    );
  } catch {
    // Policy may not exist
  }

  try {
    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch {
    // Role may already be deleted or in use — best effort
  }
}
