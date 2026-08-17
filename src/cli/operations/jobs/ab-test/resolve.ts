/**
 * Shared AB-test resolution helpers: IAM role create/reuse/delete, and ARN resolution for
 * gateway / config-bundle / online-eval references against deployed state.
 *
 * Extracted from the legacy post-deploy-ab-tests.ts so the AB-test job handler's create()
 * can own role + ARN resolution at start time (the config-as-code deploy path is removed).
 */
import type { AgentCoreProjectSpec, DeployedResourceState } from '../../../../schema';
import { getCredentialProvider } from '../../../aws/account';
import type { ABTestEvaluationConfig, ABTestVariant } from '../../../aws/agentcore-ab-tests';
import { validateIamRoleTrustPolicy } from '../../../aws/iam';
import { arnPrefix } from '../../../aws/partition';
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { createHash } from 'node:crypto';

const AB_TEST_ROLE_POLICY_NAME = 'ABTestExecutionPolicy';

/** IAM policy propagation wait after creating/updating the role (ms). */
export const IAM_PROPAGATION_DELAY_MS = 15_000;

// ============================================================================
// IAM role management
// ============================================================================

/** Generate a project-scoped role name: AgentCore-{ProjectName}-ABTest{TestName}-{Hash} (max 64 chars). */
export function generateRoleName(projectName: string, testName: string): string {
  // Deterministic hash so retries produce the same role name (avoids orphaned roles).
  const hash = createHash('sha256').update(`${projectName}:${testName}`).digest('hex').slice(0, 8);
  const base = `AgentCore-${projectName}-ABTest${testName}`;
  return `${base.slice(0, 55)}-${hash}`;
}

/** Extract role name from ARN: arn:aws:iam::123456789012:role/RoleName → RoleName. */
export function roleNameFromArn(roleArn: string): string {
  const parts = roleArn.split('/');
  return parts[parts.length - 1] ?? roleArn;
}

export interface CreateABTestRoleOptions {
  region: string;
  projectName: string;
  testName: string;
  gatewayArn: string;
  /** Injectable propagation delay (tests). */
  propagationDelayMs?: number;
}

/** Create (or reuse) the AB-test execution role + inline policy, then wait for IAM propagation. */
export async function getOrCreateABTestRole(options: CreateABTestRoleOptions): Promise<string> {
  const { region, projectName, testName, gatewayArn } = options;
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });

  // Account id from gateway ARN: arn:aws:bedrock-agentcore:REGION:ACCOUNT:gateway/ID
  const accountId = gatewayArn.split(':')[4] ?? '*';
  const roleName = generateRoleName(projectName, testName);

  const trustPolicyDocument = {
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
  };
  const trustPolicy = JSON.stringify(trustPolicyDocument);

  let roleArn: string;
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
  } catch (err: unknown) {
    // Retry after a previous failed run left the role behind — reuse it.
    if ((err as { name?: string }).name === 'EntityAlreadyExistsException') {
      const existing = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      roleArn = existing.Role?.Arn ?? '';
      if (!roleArn) {
        throw new Error(`Role "${roleName}" already exists but ARN could not be retrieved`);
      }
      validateIamRoleTrustPolicy(
        existing.Role?.AssumeRolePolicyDocument,
        trustPolicyDocument,
        roleName,
        'Delete the conflicting role or provide a customer-managed role with --role-arn.'
      );
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
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:aws/spans`,
          `${arnPrefix(region)}:logs:*:${accountId}:log-group:aws/spans:*`,
        ],
      },
    ],
  });

  // Re-apply the inline policy (idempotent — covers both new and recovered roles).
  await iamClient.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: AB_TEST_ROLE_POLICY_NAME, PolicyDocument: policy })
  );

  // Wait for IAM propagation — both new roles and policy updates on existing roles.
  await new Promise(resolve => setTimeout(resolve, options.propagationDelayMs ?? IAM_PROPAGATION_DELAY_MS));

  return roleArn;
}

/** Best-effort role cleanup: delete the inline policy then the role. */
export async function deleteABTestRole(region: string, roleArn: string): Promise<void> {
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });
  const roleName = roleNameFromArn(roleArn);

  try {
    await iamClient.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: AB_TEST_ROLE_POLICY_NAME }));
  } catch {
    // policy may not exist
  }
  try {
    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch {
    // role may already be deleted or in use — best effort
  }
}

// ============================================================================
// ARN resolution against deployed state
// ============================================================================

/** Resolve a gateway NAME (or {{gateway:name}} placeholder, or ARN) to a gateway ARN. Returns undefined if not deployed. */
export function resolveGatewayArn(ref: string, deployedResources?: DeployedResourceState): string | undefined {
  if (ref.startsWith('arn:')) return ref;
  const placeholderMatch = /^\{\{gateway:(.+)\}\}$/.exec(ref);
  const gwName = placeholderMatch ? placeholderMatch[1] : ref;

  const mcpGw = gwName ? deployedResources?.mcp?.gateways?.[gwName] : undefined;
  if (mcpGw) return mcpGw.gatewayArn;
  const httpGw = gwName ? deployedResources?.gateways?.[gwName] : undefined;
  if (httpGw) return httpGw.gatewayArn;

  return undefined;
}

/**
 * Resolve a config-bundle name (or ARN) to a bundle ARN.
 * Returns undefined when a NAME is given but not found in deployed state (i.e. not deployed),
 * so callers can surface a friendly "not deployed" error instead of sending a raw name to the API.
 */
export function resolveConfigBundleArn(ref: string, deployedResources?: DeployedResourceState): string | undefined {
  if (ref.startsWith('arn:')) return ref;
  const bundle = deployedResources?.configBundles?.[ref];
  return bundle ? bundle.bundleArn : undefined;
}

/**
 * Resolve a config-bundle version, expanding 'LATEST' to the deployed versionId.
 * Returns the explicit version verbatim; returns undefined when 'LATEST' cannot be resolved
 * (bundle not deployed) so the caller can error rather than send 'LATEST' to the API.
 */
export function resolveConfigBundleVersion(
  bundleRef: string,
  versionRef: string,
  deployedResources?: DeployedResourceState
): string | undefined {
  if (versionRef !== 'LATEST') return versionRef;
  const name = bundleRef.startsWith('arn:') ? undefined : bundleRef;
  const bundle = name ? deployedResources?.configBundles?.[name] : undefined;
  return bundle ? bundle.versionId : undefined;
}

/**
 * Resolve an online-eval config name (or ARN) to its ARN.
 * Returns undefined when a NAME is given but not found in deployed state (i.e. not deployed).
 */
export function resolveOnlineEvalArn(ref: string, deployedResources?: DeployedResourceState): string | undefined {
  if (ref.startsWith('arn:')) return ref;
  const config = deployedResources?.onlineEvalConfigs?.[ref];
  return config ? config.onlineEvaluationConfigArn : undefined;
}

/**
 * Find the gateway target(s) that route to a runtime, for building a config-bundle test's invocation URL.
 *
 * Config-bundle variants carry bundle ARNs, not targets — the only runtime the user names is `--runtime`,
 * which is a RUNTIME name and NOT a valid gateway path segment. The runtime→target link lives solely in
 * `agentCoreGateways[].targets[].httpRuntime.runtime`, so reverse-resolve it here. The L3 CDK deploys each
 * target under its spec name verbatim, so a spec target name IS the deployed path segment.
 *
 * Returns every httpRuntime target on the gateway that fronts the runtime, in spec order. Callers treat a
 * single match as the invocation path and expose several as ambiguous candidates (e.g. a canary beside
 * prod), never guessing one — a wrong path 404s with "No Target found for Target name: ..." (issue #1854).
 */
export function resolveRuntimeTargetNames(
  gatewayName: string | undefined,
  runtimeName: string | undefined,
  projectSpec: Pick<AgentCoreProjectSpec, 'agentCoreGateways'>
): string[] {
  if (!gatewayName || !runtimeName) return [];
  const gateway = (projectSpec.agentCoreGateways ?? []).find(g => g.name === gatewayName);
  return (gateway?.targets ?? [])
    .filter(t => t.targetType === 'httpRuntime' && t.httpRuntime?.runtime === runtimeName)
    .map(t => t.name);
}

export type { ABTestEvaluationConfig, ABTestVariant };
