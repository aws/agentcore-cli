import { ConfigIO } from '../../../lib';
import type { HarnessInfo } from './types';

/**
 * List deployed harnesses with their inbound authorizer type. A harness is included only when
 * it is registered in the project AND present in deployed-state (mirrors listAgents/listGateways).
 * The authorizerType lives in each harness.json, so the per-harness spec is read to surface it.
 */
export async function listHarnesses(
  options: { configIO?: ConfigIO; deployTarget?: string } = {}
): Promise<HarnessInfo[]> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) return [];

  const targetName = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[targetName];
  if (!target) return [];

  const deployedHarnesses = target.resources?.harnesses ?? {};

  const harnesses: HarnessInfo[] = [];

  for (const harness of projectSpec.harnesses) {
    const deployed = deployedHarnesses[harness.name];
    if (!deployed?.harnessArn) continue;

    let authType = 'AWS_IAM';
    try {
      const spec = await configIO.readHarnessSpec(harness.name);
      authType = spec.authorizerType ?? 'AWS_IAM';
    } catch {
      // Spec unreadable — fall back to the AWS_IAM default rather than dropping the harness.
    }

    harnesses.push({ name: harness.name, authType });
  }

  return harnesses;
}
