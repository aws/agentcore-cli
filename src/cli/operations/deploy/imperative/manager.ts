import type { DeployPhase, ImperativeDeployContext, ImperativeDeployResult, ImperativeDeployer } from './types';

export interface ImperativePhaseResult {
  success: boolean;
  results: Map<string, ImperativeDeployResult>;
  error?: string;
  notes: string[];
}

export class ImperativeDeploymentManager {
  private readonly deployers: ImperativeDeployer[] = [];

  register(deployer: ImperativeDeployer): this {
    this.deployers.push(deployer);
    return this;
  }

  async runPhase(phase: DeployPhase, context: ImperativeDeployContext): Promise<ImperativePhaseResult> {
    const results = new Map<string, ImperativeDeployResult>();
    const notes: string[] = [];

    const applicable = this.deployers.filter(d => d.phase === phase && d.shouldRun(context));

    for (const deployer of applicable) {
      context.onProgress?.(deployer.label, 'start');

      try {
        const result = await deployer.deploy(context);
        results.set(deployer.name, result);

        if (result.notes) {
          notes.push(...result.notes);
        }

        if (!result.success) {
          context.onProgress?.(deployer.label, 'error');
          return {
            success: false,
            results,
            error: result.error ?? `Deployer '${deployer.name}' failed`,
            notes,
          };
        }

        context.onProgress?.(deployer.label, 'done');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.set(deployer.name, { success: false, error: errorMessage });
        context.onProgress?.(deployer.label, 'error');
        return {
          success: false,
          results,
          error: errorMessage,
          notes,
        };
      }
    }

    return { success: true, results, notes };
  }

  async teardownAll(context: ImperativeDeployContext): Promise<ImperativePhaseResult> {
    const results = new Map<string, ImperativeDeployResult>();
    const notes: string[] = [];
    const errors: string[] = [];

    const applicable = this.deployers.filter(d => d.shouldRun(context)).reverse();

    for (const deployer of applicable) {
      context.onProgress?.(deployer.label, 'start');

      try {
        const result = await deployer.teardown(context);
        results.set(deployer.name, result);

        if (result.notes) {
          notes.push(...result.notes);
        }

        if (!result.success) {
          context.onProgress?.(deployer.label, 'error');
          errors.push(result.error ?? `Teardown of '${deployer.name}' failed`);
          continue;
        }

        context.onProgress?.(deployer.label, 'done');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.set(deployer.name, { success: false, error: errorMessage });
        context.onProgress?.(deployer.label, 'error');
        errors.push(errorMessage);
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        results,
        error: errors.join('; '),
        notes,
      };
    }

    return { success: true, results, notes };
  }

  hasDeployersForPhase(phase: DeployPhase, context: ImperativeDeployContext): boolean {
    return this.deployers.some(d => d.phase === phase && d.shouldRun(context));
  }
}
