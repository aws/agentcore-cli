import { ConfigIO } from '../../../lib';

export async function getRegion(cliRegion?: string): Promise<string> {
  if (cliRegion) return cliRegion;
  try {
    const configIO = new ConfigIO();
    const targets = await configIO.resolveAWSDeploymentTargets();
    if (targets.length > 0) return targets[0]!.region;
  } catch {
    // Fall through to env vars
  }
  return process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
}
