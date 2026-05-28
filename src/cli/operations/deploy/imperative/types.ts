import type { ConfigIO } from '../../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTarget, DeployedState } from '../../../../schema';

export type DeployPhase = 'pre-cdk' | 'post-cdk' | 'standalone';

export type DeployProgress = (step: string, status: 'start' | 'done' | 'error') => void;

export interface ImperativeDeployContext {
  projectSpec: AgentCoreProjectSpec;
  target: AwsDeploymentTarget;
  configIO: ConfigIO;
  deployedState: DeployedState;
  onProgress?: DeployProgress;
  cdkOutputs?: Record<string, string>;
  autoConfirm?: boolean;
}

export interface ImperativeDeployResult<TState = Record<string, unknown>> {
  success: boolean;
  state?: TState;
  notes?: string[];
  error?: string;
}

export interface ImperativeDeployer<TState = Record<string, unknown>> {
  readonly name: string;
  readonly label: string;
  readonly phase: DeployPhase;
  shouldRun(context: ImperativeDeployContext): boolean;
  deploy(context: ImperativeDeployContext): Promise<ImperativeDeployResult<TState>>;
  teardown(context: ImperativeDeployContext): Promise<ImperativeDeployResult<TState>>;
}
