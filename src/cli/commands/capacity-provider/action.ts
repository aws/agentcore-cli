import { ConfigIO, findConfigRoot } from '../../../lib';
import { isCapacityProviderArn } from '../../../schema';
import { deleteCapacityProviderSession as deleteCapacityProviderSessionApi } from '../../aws/agentcore';
import { regionFromArn } from '../../aws/arn';
import { detectRegion } from '../../aws/region';
import { isCapacityProviderId } from './constants';

export interface DeleteCapacityProviderSessionActionOptions {
  /** Capacity provider name (in-project) or ARN (external). */
  capacityProvider: string;
  /** Session id to delete. */
  sessionId: string;
  /** AWS region override (auto-detected from ARN / project / environment otherwise). */
  region?: string;
}

export interface ResolvedDeleteTarget {
  capacityProviderId: string;
  capacityProviderArn?: string;
  region: string;
  /** True when targeted by raw ARN (no project needed). */
  targetByArn: boolean;
  /** Human-friendly label for prompts/output (name or ARN). */
  displayName: string;
}

/** Extract the capacity provider id (the last path segment) from a CP ARN. */
function capacityProviderIdFromArn(arn: string): string {
  return arn.split('/').pop() ?? arn;
}

/**
 * Resolve the capacity provider id + region for a delete-session call, from either a raw ARN
 * (no project required) or an in-project capacity-provider name (resolved via deployed-state).
 * Throws with an actionable message when the name is not found / not deployed.
 */
export async function resolveDeleteTarget(
  options: DeleteCapacityProviderSessionActionOptions
): Promise<ResolvedDeleteTarget> {
  // (1) External CP by ARN — extract the id the API requires (the last ARN path segment).
  if (isCapacityProviderArn(options.capacityProvider)) {
    const arn = options.capacityProvider;
    const region = options.region ?? regionFromArn(arn) ?? (await detectRegion()).region;
    return {
      capacityProviderId: capacityProviderIdFromArn(arn),
      capacityProviderArn: arn,
      region,
      targetByArn: true,
      displayName: arn,
    };
  }

  // (2) A literal capacity provider id (`{name}-{10 alnum}`) — the data-plane API path parameter.
  // No project needed; region comes from --region or the environment.
  if (isCapacityProviderId(options.capacityProvider)) {
    const region = options.region ?? (await detectRegion()).region;
    return {
      capacityProviderId: options.capacityProvider,
      region,
      targetByArn: false,
      displayName: options.capacityProvider,
    };
  }

  // (3) An in-project capacity provider name — resolve to its id via deployed-state.
  const name = options.capacityProvider;
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error(
      `No AgentCore project found. Run inside a project to reference "${name}" by name, or pass the capacity provider id or ARN.`
    );
  }
  const configIO = new ConfigIO({ baseDir: configRoot });
  const deployed = await configIO.readDeployedState();

  // Deployed state is keyed per target; find the target that has this capacity provider.
  let record: { capacityProviderId: string; capacityProviderArn: string } | undefined;
  for (const target of Object.values(deployed.targets)) {
    const found = target.resources?.capacityProviders?.[name];
    if (found) {
      record = found;
      break;
    }
  }
  if (!record) {
    throw new Error(
      `Capacity provider "${name}" is not deployed in this project. Deploy it first, or pass its id or ARN with --capacity-provider.`
    );
  }

  // The capacity provider ARN always carries the region, so it is the most reliable source.
  const region = options.region ?? regionFromArn(record.capacityProviderArn) ?? (await detectRegion()).region;

  return {
    capacityProviderId: record.capacityProviderId,
    capacityProviderArn: record.capacityProviderArn,
    region,
    targetByArn: false,
    displayName: name,
  };
}

/** Perform the delete-session data-plane call for a resolved target. */
export async function executeDeleteCapacityProviderSession(target: ResolvedDeleteTarget, sessionId: string) {
  return deleteCapacityProviderSessionApi({
    region: target.region,
    capacityProviderId: target.capacityProviderId,
    sessionId,
  });
}
