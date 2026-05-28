import { HarnessDeployer } from './deployers';
import { ImperativeDeploymentManager } from './manager';

export type {
  DeployPhase,
  DeployProgress,
  ImperativeDeployContext,
  ImperativeDeployResult,
  ImperativeDeployer,
} from './types';

export { ImperativeDeploymentManager, type ImperativePhaseResult } from './manager';

export { HarnessDeployer, mapHarnessSpecToCreateOptions, type MapHarnessOptions } from './deployers';

export function createDeploymentManager(): ImperativeDeploymentManager {
  return new ImperativeDeploymentManager().register(new HarnessDeployer());
}
