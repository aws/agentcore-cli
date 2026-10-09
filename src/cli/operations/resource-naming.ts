import { ValidationError } from '../../lib/errors/types';
import { type AwsDeploymentTarget, ProjectNameSchema } from '../../schema';

type TargetNaming = Pick<AwsDeploymentTarget, 'resourceNameSuffix'>;

/**
 * The project name used as the prefix of deployed resource names for a target
 * (e.g. runtime `${physicalProjectName}_${agentName}`).
 *
 * A target's optional `resourceNameSuffix` is appended so several targets can share one
 * account+region without physical-name collisions. Without a suffix this is the plain project
 * name, so existing deployments keep their resource names. The vended CDK app
 * (src/assets/cdk/bin/cdk.ts) applies the same rule — keep the two in sync.
 */
export function getPhysicalProjectName(projectName: string, target?: TargetNaming): string {
  return `${projectName}${target?.resourceNameSuffix ?? ''}`;
}

/**
 * Like {@link getPhysicalProjectName}, but looks the target up by name. Unknown target names fall
 * back to the plain project name.
 */
export function getPhysicalProjectNameForTarget(
  projectName: string,
  awsTargets: readonly AwsDeploymentTarget[],
  targetName: string | undefined
): string {
  return getPhysicalProjectName(
    projectName,
    awsTargets.find(t => t.name === targetName)
  );
}

/**
 * Ensures project name + suffix is still a valid project name. The suffixed name replaces the
 * project name everywhere physical names are built, so it must respect the same 23-char budget
 * that keeps `${projectName}_${resourceName}` within the 48-char AWS limits.
 */
export function validatePhysicalProjectName(projectName: string, target: AwsDeploymentTarget): void {
  if (!target.resourceNameSuffix) return;
  const physicalName = getPhysicalProjectName(projectName, target);
  const result = ProjectNameSchema.safeParse(physicalName);
  if (!result.success) {
    throw new ValidationError(
      `Target "${target.name}": project name plus resourceNameSuffix ("${physicalName}") is not a valid ` +
        `resource name prefix: ${result.error.issues[0]?.message ?? 'invalid'}. ` +
        `Use a shorter resourceNameSuffix in aws-targets.json.`
    );
  }
}
