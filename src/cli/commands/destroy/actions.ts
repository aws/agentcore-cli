import { getErrorMessage } from '../../errors';
import { destroyTarget, discoverDeployedTargets, getCdkProjectDir } from '../../operations/destroy';
import type { DestroyResult } from './types';

export interface ValidatedDestroyOptions {
  target: string;
  autoConfirm?: boolean;
}

export async function handleDestroy(options: ValidatedDestroyOptions): Promise<DestroyResult> {
  try {
    const discovered = await discoverDeployedTargets();
    const deployedTarget = discovered.deployedTargets.find(dt => dt.target.name === options.target);

    if (!deployedTarget) {
      return {
        success: false,
        error: `Target '${options.target}' not found or not deployed`,
      };
    }

    // Require explicit confirmation for destructive operation
    if (!options.autoConfirm) {
      return {
        success: false,
        error: `Destroy requires confirmation. Run with --yes to confirm, or use the interactive TUI.`,
      };
    }

    const cdkProjectDir = getCdkProjectDir();
    await destroyTarget({ target: deployedTarget, cdkProjectDir });

    return {
      success: true,
      targetName: deployedTarget.target.name,
      stackName: deployedTarget.stack.stackName,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
