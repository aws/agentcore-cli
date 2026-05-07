import type { AgentCoreProjectSpec, DeployedResourceState, HttpGatewayDeployedState } from '../../../schema';
import { getCredentialProvider } from '../../aws/account';
import {
  createHttpGateway,
  createHttpGatewayTarget,
  deleteHttpGateway,
  deleteHttpGatewayTarget,
  getHttpGatewayTarget,
  listAllHttpGateways,
  listHttpGatewayTargets,
  waitForGatewayReady,
  waitForTargetReady,
} from '../../aws/agentcore-http-gateways';
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

export interface SetupHttpGatewaysOptions {
  region: string;
  projectName: string;
  projectSpec: AgentCoreProjectSpec;
  existingHttpGateways?: Record<string, HttpGatewayDeployedState>;
  deployedResources?: DeployedResourceState;
}

export interface HttpGatewaySetupResult {
  gatewayName: string;
  status: 'created' | 'skipped' | 'deleted' | 'error';
  gatewayId?: string;
  gatewayArn?: string;
  error?: string;
}

export interface SetupHttpGatewaysResult {
  results: HttpGatewaySetupResult[];
  httpGateways: Record<string, HttpGatewayDeployedState>;
  hasErrors: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const HTTP_GATEWAY_ROLE_POLICY_NAME = 'HttpGatewayExecutionPolicy';

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create or delete HTTP gateways post-deploy.
 *
 * Pattern:
 * 1. For each httpGateway in project spec -> resolve runtime ARN, create or skip
 * 2. For each httpGateway in deployed-state but NOT in project spec -> delete (reconciliation)
 * 3. Return updated deployed state entries
 */
export async function setupHttpGateways(options: SetupHttpGatewaysOptions): Promise<SetupHttpGatewaysResult> {
  const { region, projectName, projectSpec, existingHttpGateways, deployedResources } = options;
  const results: HttpGatewaySetupResult[] = [];
  const httpGateways: Record<string, HttpGatewayDeployedState> = {};

  // Defensive: Zod .default([]) only fires on undefined, not null.
  // If someone has "httpGateways": null in their JSON, it passes through as null.
  const httpGatewaySpecs = projectSpec.httpGateways ?? [];

  // Create or skip gateways from the spec
  for (const gwSpec of httpGatewaySpecs) {
    let resolvedRoleArn: string | undefined;
    let roleCreatedByCli = false;
    try {
      const existingGateway = existingHttpGateways?.[gwSpec.name];

      if (existingGateway) {
        // Already deployed

        // Create or update targets from httpGateways[].targets (for target-based AB testing)
        if (gwSpec.targets && gwSpec.targets.length > 0) {
          // List existing targets to avoid unnecessary create calls
          const existingTargetsByName = new Map<string, { targetId: string }>();
          try {
            const existingTargets = await listHttpGatewayTargets({
              region,
              gatewayId: existingGateway.gatewayId,
            });
            for (const t of existingTargets.targets) {
              existingTargetsByName.set(t.name, { targetId: t.targetId });
            }
          } catch {
            // If list fails, fall through and let create handle 409s
          }

          for (const tgt of gwSpec.targets) {
            const existingTarget = existingTargetsByName.get(`${projectName}-${tgt.name}`);
            if (existingTarget) {
              // Target exists by name — check if qualifier matches
              try {
                const targetDetails = await getHttpGatewayTarget({
                  region,
                  gatewayId: existingGateway.gatewayId,
                  targetId: existingTarget.targetId,
                });
                const httpConfig = (
                  targetDetails.targetConfiguration as
                    | {
                        http?: {
                          agentcoreRuntime?: { qualifier?: string };
                          runtimeTargetConfiguration?: { qualifier?: string };
                        };
                      }
                    | undefined
                )?.http;
                const existingQualifier =
                  httpConfig?.agentcoreRuntime?.qualifier ?? httpConfig?.runtimeTargetConfiguration?.qualifier;
                const specQualifier = tgt.qualifier ?? 'DEFAULT';
                if (existingQualifier === specQualifier) {
                  // Qualifier matches — skip
                  continue;
                }
                // Qualifier differs — delete old target and recreate
                await deleteHttpGatewayTarget({
                  region,
                  gatewayId: existingGateway.gatewayId,
                  targetId: existingTarget.targetId,
                });
              } catch {
                // If get/delete fails, fall through to create which will handle conflicts
              }
            }
            try {
              const tgtRuntime = deployedResources?.runtimes?.[tgt.runtimeRef];
              if (!tgtRuntime) continue;
              const tgtResult = await createHttpGatewayTarget({
                region,
                gatewayId: existingGateway.gatewayId,
                targetName: `${projectName}-${tgt.name}`,
                runtimeArn: tgtRuntime.runtimeArn,
                qualifier: tgt.qualifier,
              });
              await waitForTargetReady({
                region,
                gatewayId: existingGateway.gatewayId,
                targetId: tgtResult.targetId,
              });
            } catch (tgtErr) {
              if (tgtErr instanceof Error && tgtErr.message.includes('409')) continue;
              // Non-fatal
            }
          }
        }

        httpGateways[gwSpec.name] = existingGateway;
        results.push({
          gatewayName: gwSpec.name,
          status: 'skipped',
          gatewayId: existingGateway.gatewayId,
          gatewayArn: existingGateway.gatewayArn,
        });
        continue;
      }

      // Try to find by name via list (handles re-creation after state loss)
      const prefixedGatewayName = `${projectName}-${gwSpec.name}`;
      const existingByName = await findHttpGatewayByName(region, prefixedGatewayName);
      if (existingByName) {
        console.warn(
          `Warning: HTTP gateway "${gwSpec.name}" found by name but local state was lost. Target and role state may be incomplete — consider re-deploying.`
        );
        httpGateways[gwSpec.name] = {
          gatewayId: existingByName.gatewayId,
          gatewayArn: existingByName.gatewayArn,
          // targetId, roleArn, roleCreatedByCli unknown after state-loss recovery
        };
        results.push({
          gatewayName: gwSpec.name,
          status: 'skipped',
          gatewayId: existingByName.gatewayId,
          gatewayArn: existingByName.gatewayArn,
        });
        continue;
      }

      // Migration fallback: try unprefixed name for pre-PR gateways (Comment 3 fix)
      const existingByLegacyName = await findHttpGatewayByName(region, gwSpec.name);
      if (existingByLegacyName) {
        console.warn(
          `Warning: HTTP gateway "${gwSpec.name}" was found using its pre-migration name. ` +
            `This CLI version uses the naming convention "${prefixedGatewayName}". ` +
            `The gateway has been recovered from state loss. ` +
            `You may want to rename "${gwSpec.name}" to "${prefixedGatewayName}" on AWS to match the new convention.`
        );
        httpGateways[gwSpec.name] = {
          gatewayId: existingByLegacyName.gatewayId,
          gatewayArn: existingByLegacyName.gatewayArn,
          // targetId, roleArn, roleCreatedByCli unknown after state-loss recovery
        };
        results.push({
          gatewayName: gwSpec.name,
          status: 'skipped',
          gatewayId: existingByLegacyName.gatewayId,
          gatewayArn: existingByLegacyName.gatewayArn,
        });
        continue;
      }

      // Resolve runtime ARN from deployed state
      const runtimeState = deployedResources?.runtimes?.[gwSpec.runtimeRef];
      if (!runtimeState) {
        results.push({
          gatewayName: gwSpec.name,
          status: 'error',
          error: `Runtime "${gwSpec.runtimeRef}" not found in deployed resources. Deploy the runtime before creating an HTTP gateway.`,
        });
        continue;
      }
      const runtimeArn = runtimeState.runtimeArn;
      if (gwSpec.roleArn) {
        resolvedRoleArn = gwSpec.roleArn;
      } else {
        resolvedRoleArn = await getOrCreateHttpGatewayRole({
          region,
          projectName,
          gatewayName: gwSpec.name,
          runtimeArn,
        });
        roleCreatedByCli = true;
      }

      // Create gateway and wait for it to become READY before adding targets
      // Creating HTTP gateway for runtime
      const createResult = await createHttpGateway({
        region,
        name: `${projectName}-${gwSpec.name}`,
        roleArn: resolvedRoleArn,
      });

      const readyGateway = await waitForGatewayReady({
        region,
        gatewayId: createResult.gatewayId,
      });

      // Create target pointing to the runtime
      let targetId: string | undefined;
      try {
        const targetResult = await createHttpGatewayTarget({
          region,
          gatewayId: createResult.gatewayId,
          targetName: `${projectName}-${gwSpec.runtimeRef}`,
          runtimeArn,
        });

        targetId = targetResult.targetId;

        // Wait for target to become ready
        // Waiting for gateway target to become ready
        await waitForTargetReady({
          region,
          gatewayId: createResult.gatewayId,
          targetId: targetResult.targetId,
        });
      } catch (targetErr) {
        // Rollback: delete target (if created), wait for deletion, then delete gateway
        try {
          if (targetId) {
            await deleteHttpGatewayTarget({ region, gatewayId: createResult.gatewayId, targetId });
          }
        } catch {
          // Best-effort target cleanup
        }
        try {
          await deleteHttpGateway({ region, gatewayId: createResult.gatewayId });
        } catch {
          // Best-effort gateway rollback
        }

        // Always clean up auto-created role on target failure, regardless of gateway rollback result
        if (roleCreatedByCli && resolvedRoleArn) {
          try {
            await deleteHttpGatewayRole(region, resolvedRoleArn);
          } catch {
            // Best-effort role cleanup
          }
        }

        results.push({
          gatewayName: gwSpec.name,
          status: 'error',
          error: `Target creation failed, gateway rolled back: ${targetErr instanceof Error ? targetErr.message : String(targetErr)}`,
        });
        continue;
      }

      // Create additional targets from httpGateways[].targets (for target-based AB testing)
      if (gwSpec.targets && gwSpec.targets.length > 0) {
        for (const tgt of gwSpec.targets) {
          try {
            const tgtRuntime = deployedResources?.runtimes?.[tgt.runtimeRef];
            if (!tgtRuntime) {
              // Runtime not deployed, skip this target
              continue;
            }
            const tgtResult = await createHttpGatewayTarget({
              region,
              gatewayId: createResult.gatewayId,
              targetName: `${projectName}-${tgt.name}`,
              runtimeArn: tgtRuntime.runtimeArn,
              qualifier: tgt.qualifier,
            });
            await waitForTargetReady({
              region,
              gatewayId: createResult.gatewayId,
              targetId: tgtResult.targetId,
            });
          } catch (tgtErr) {
            // 409 = already exists, skip
            if (tgtErr instanceof Error && tgtErr.message.includes('409')) continue;
            // Non-fatal: log but continue
          }
        }
      }

      httpGateways[gwSpec.name] = {
        gatewayId: createResult.gatewayId,
        gatewayArn: createResult.gatewayArn,
        gatewayUrl: readyGateway.gatewayUrl,
        targetId,
        roleArn: resolvedRoleArn,
        roleCreatedByCli,
      };

      results.push({
        gatewayName: gwSpec.name,
        status: 'created',
        gatewayId: createResult.gatewayId,
        gatewayArn: createResult.gatewayArn,
      });
    } catch (err) {
      // If we auto-created a role, clean it up on failure
      if (roleCreatedByCli && resolvedRoleArn) {
        try {
          await deleteHttpGatewayRole(region, resolvedRoleArn);
        } catch {
          // Best-effort role cleanup
        }
      }
      results.push({
        gatewayName: gwSpec.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orphaned gateways are deleted by deleteOrphanedHttpGateways() which runs
  // as a separate pre-pass. No deletion loop here.

  return {
    results,
    httpGateways,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

// ============================================================================
// Shared Gateway Deletion
// ============================================================================

/**
 * Delete an HTTP gateway and all its targets. Best-effort — target failures
 * are warned but don't prevent gateway deletion attempt.
 *
 * Order: targets → gateway → role
 */
export async function deleteHttpGatewayWithTargets(options: {
  region: string;
  gatewayId: string;
  gatewayName: string;
  knownTargetId?: string;
  roleArn?: string;
  roleCreatedByCli?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const { region, gatewayId, gatewayName, knownTargetId, roleArn, roleCreatedByCli } = options;

  const targetIds: string[] = [];
  if (knownTargetId) {
    targetIds.push(knownTargetId);
  }
  try {
    const targets = await listHttpGatewayTargets({ region, gatewayId, maxResults: 100 });
    for (const t of targets.targets) {
      if (!targetIds.includes(t.targetId)) {
        targetIds.push(t.targetId);
      }
    }
  } catch {
    // Best-effort — proceed with whatever IDs we have
  }

  for (const targetId of targetIds) {
    try {
      await deleteHttpGatewayTarget({ region, gatewayId, targetId });
    } catch (err) {
      console.warn(
        `Warning: Failed to delete target ${targetId} on gateway "${gatewayName}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const deleteResult = await deleteHttpGateway({ region, gatewayId });
  if (!deleteResult.success) {
    return { success: false, error: deleteResult.error };
  }

  if (roleCreatedByCli && roleArn) {
    try {
      await deleteHttpGatewayRole(region, roleArn);
    } catch {
      // Best-effort role cleanup
    }
  }

  return { success: true };
}

/**
 * Delete orphaned HTTP gateways (in deployed-state but removed from spec).
 * Call before setupHttpGateways.
 */
export async function deleteOrphanedHttpGateways(options: {
  region: string;
  projectSpec: AgentCoreProjectSpec;
  existingHttpGateways?: Record<string, HttpGatewayDeployedState>;
}): Promise<{ results: HttpGatewaySetupResult[]; hasErrors: boolean }> {
  const { region, projectSpec, existingHttpGateways } = options;
  if (!existingHttpGateways) return { results: [], hasErrors: false };

  const specGatewayNames = new Set((projectSpec.httpGateways ?? []).map(g => g.name));
  const results: HttpGatewaySetupResult[] = [];

  for (const [gwName, gwState] of Object.entries(existingHttpGateways)) {
    if (!specGatewayNames.has(gwName)) {
      try {
        const result = await deleteHttpGatewayWithTargets({
          region,
          gatewayId: gwState.gatewayId,
          gatewayName: gwName,
          knownTargetId: gwState.targetId,
          roleArn: gwState.roleArn,
          roleCreatedByCli: gwState.roleCreatedByCli,
        });

        results.push({
          gatewayName: gwName,
          status: result.success ? 'deleted' : 'error',
          error: result.error,
        });
      } catch (err) {
        results.push({
          gatewayName: gwName,
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
// Gateway Trace Delivery
// ============================================================================

// ============================================================================
// Helpers
// ============================================================================

async function findHttpGatewayByName(
  region: string,
  name: string
): Promise<{ gatewayId: string; gatewayArn: string } | undefined> {
  try {
    const gateways = await listAllHttpGateways({ region });
    return gateways.find(gw => gw.name === name);
  } catch (err) {
    console.warn(
      `Warning: Could not list HTTP gateways to check for existing "${name}": ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

// ============================================================================
// IAM Role Management
// ============================================================================

/**
 * Generate a project-scoped role name following the CDK pattern:
 * AgentCore-{ProjectName}-HttpGw{GatewayName}-{Hash}
 */
function generateRoleName(projectName: string, gatewayName: string): string {
  const base = `AgentCore-${projectName}-HttpGw${gatewayName}`;
  // Use deterministic hash so retries produce the same role name
  const hash = createHash('sha256').update(`${projectName}:${gatewayName}`).digest('hex').slice(0, 8);
  // IAM role names max 64 chars
  return `${base.slice(0, 55)}-${hash}`;
}

/**
 * Extract role name from ARN: arn:aws:iam::123456789012:role/RoleName -> RoleName
 */
function roleNameFromArn(roleArn: string): string {
  const parts = roleArn.split('/');
  return parts[parts.length - 1] ?? roleArn;
}

interface CreateHttpGatewayRoleOptions {
  region: string;
  projectName: string;
  gatewayName: string;
  runtimeArn: string;
}

async function getOrCreateHttpGatewayRole(options: CreateHttpGatewayRoleOptions): Promise<string> {
  const { region, projectName, gatewayName } = options;
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });

  const roleName = generateRoleName(projectName, gatewayName);

  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  });

  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'InvokeRuntimeStatement',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:InvokeRuntime',
          'bedrock-agentcore:InvokeAgent',
          'bedrock-agentcore:InvokeAgentRuntime',
        ],
        // Resource must be '*' because the gateway service invokes runtimes using
        // a resource identifier that doesn't match the deployed runtime ARN format.
        // This matches the A/B testing guide's gateway role policy.
        Resource: '*',
      },
    ],
  });

  let roleArn: string;
  let needsPropagationWait = false;

  try {
    const createResult = await iamClient.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy,
        Description: `Auto-created execution role for AgentCore HTTP gateway: ${gatewayName}`,
        Tags: [
          { Key: 'agentcore:created-by', Value: 'agentcore-cli' },
          { Key: 'agentcore:project-name', Value: projectName },
          { Key: 'agentcore:http-gateway-name', Value: gatewayName },
        ],
      })
    );

    roleArn = createResult.Role?.Arn ?? '';
    if (!roleArn) {
      throw new Error(`IAM CreateRole succeeded but returned no role ARN for "${roleName}"`);
    }
    needsPropagationWait = true;
  } catch (err: unknown) {
    // Handle retry after a previous failed deploy left the role behind
    const errName = (err as { name?: string }).name;
    if (errName === 'EntityAlreadyExistsException') {
      // IAM role already exists — reusing
      const existing = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      roleArn = existing.Role?.Arn ?? '';
      if (!roleArn) {
        throw new Error(`Role "${roleName}" already exists but ARN could not be retrieved`);
      }
    } else {
      throw new Error(
        `Failed to create IAM role "${roleName}" for HTTP gateway "${gatewayName}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Re-apply the inline policy (idempotent — covers both new and recovered roles)
  await iamClient.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: HTTP_GATEWAY_ROLE_POLICY_NAME,
      PolicyDocument: policy,
    })
  );

  if (needsPropagationWait) {
    // Waiting for IAM role propagation (~15s)
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }

  return roleArn;
}

export async function deleteHttpGatewayRole(region: string, roleArn: string): Promise<void> {
  const credentials = getCredentialProvider();
  const iamClient = new IAMClient({ region, credentials });
  const roleName = roleNameFromArn(roleArn);

  try {
    // Must delete inline policies before deleting the role
    await iamClient.send(
      new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: HTTP_GATEWAY_ROLE_POLICY_NAME,
      })
    );
  } catch {
    // Policy may not exist
  }

  try {
    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch {
    // Role may already be deleted or in use -- best effort
  }
}
