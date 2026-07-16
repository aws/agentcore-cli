import { syncManagedDependencies } from '../../../lib/dependency-management';
import type { DependencySyncResult } from '../../../lib/dependency-management';
import { readGlobalConfigSync } from '../../../lib/schemas/io/global-config';
import type { LocalCdkProject } from '../../cdk/local-cdk-project';
import { getTemplatePath } from '../../templates/templateRoot';

/**
 * Deploy-preflight entry point for managed dependency pinning (#1540): resolves the
 * CLI's vended CDK package.json (source of truth) and the global opt-out, then runs
 * the sync against the project's agentcore/cdk directory. A future `agentcore build`
 * command should call this same function.
 *
 * Throws CliVersionTooOldError when the project was updated by a newer CLI, and
 * DependencySyncError on rewrite/reinstall failure.
 */
export async function ensureManagedDependencies(cdkProject: LocalCdkProject): Promise<DependencySyncResult> {
  const disabled = readGlobalConfigSync().disableDependencyManagement === true;
  return syncManagedDependencies({
    vendedPackageJsonPath: getTemplatePath('cdk', 'package.json'),
    projectDir: cdkProject.projectDir,
    disabled,
  });
}

export type { DependencySyncResult };
