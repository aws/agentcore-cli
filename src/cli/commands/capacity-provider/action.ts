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

  // Deployed state is keyed per target, and the same capacity-provider name can be deployed in more
  // than one target/region. Collect every match and disambiguate by region rather than blindly
  // taking the first — otherwise a caller-supplied --region could be paired with an id from a
  // different target and the delete would be sent to the wrong region.
  const matches = Object.values(deployed.targets)
    .map(target => target.resources?.capacityProviders?.[name])
    .filter((r): r is { capacityProviderId: string; capacityProviderArn: string } => Boolean(r))
    .map(r => ({ ...r, region: regionFromArn(r.capacityProviderArn) }));

  if (matches.length === 0) {
    throw new Error(
      `Capacity provider "${name}" is not deployed in this project. Deploy it first, or pass its id or ARN with --capacity-provider.`
    );
  }

  const deployedRegions = [...new Set(matches.map(m => m.region).filter(Boolean))].join(', ');
  let record: { capacityProviderId: string; capacityProviderArn: string; region?: string };
  if (options.region) {
    // Constrain resolution to the requested region so the id and region always come from the same
    // deployment.
    const inRegion = matches.filter(m => m.region === options.region);
    if (inRegion.length === 0) {
      throw new Error(
        `Capacity provider "${name}" is not deployed in region ${options.region}${deployedRegions ? ` (found in: ${deployedRegions})` : ''}. Pass a matching --region, or the capacity provider id or ARN with --capacity-provider.`
      );
    }
    if (inRegion.length > 1) {
      throw new Error(
        `Capacity provider "${name}" resolves to multiple deployments in region ${options.region}. Pass the capacity provider id or ARN with --capacity-provider to disambiguate.`
      );
    }
    record = inRegion[0]!;
  } else if (matches.length > 1) {
    throw new Error(
      `Capacity provider "${name}" is deployed in multiple regions (${deployedRegions}). Pass --region to select one, or the capacity provider id or ARN with --capacity-provider.`
    );
  } else {
    record = matches[0]!;
  }

  // The capacity provider ARN always carries the region, so it is the most reliable source.
  const region = options.region ?? record.region ?? (await detectRegion()).region;

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
