import type { Project } from "../../handlers/project/types";

/**
 * True when the spec declares none of the resources `removeAllResources`
 * clears, i.e. what an emptied project looks like. This is the up-front proxy
 * for the backend's post-synth zero-resource count; the two can disagree when a
 * declared resource synthesizes no CloudFormation resource (or a hand-edited
 * CDK app adds one), so the backend's count stays authoritative and this only
 * decides whether to ask the user before starting, and whether a CDK dependency
 * problem only warns so the teardown still runs.
 */
export function declaresNothingDeployable(project: Project): boolean {
  const { spec } = project;
  const collections = [
    spec.runtimes,
    spec.memories,
    spec.knowledgeBases,
    spec.credentials,
    spec.evaluators,
    spec.onlineEvalConfigs,
    spec.agentCoreGateways,
    spec.policyEngines,
    spec.configBundles,
    spec.harnesses,
    spec.toolRuntimes ?? [],
    spec.payments ?? [],
  ];
  return collections.every((collection) => collection.length === 0);
}
