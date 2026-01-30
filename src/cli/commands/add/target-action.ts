import { ConfigIO, NoProjectError, findConfigRoot } from '../../../lib';
import type { AwsDeploymentTarget } from '../../../schema';
import { AgentCoreRegionSchema, AwsAccountIdSchema, DeploymentTargetNameSchema } from '../../../schema';
import { getErrorMessage } from '../../errors';

export interface AddTargetOptions {
  name: string;
  account: string;
  region: string;
  description?: string;
}

export interface AddTargetResult {
  success: boolean;
  error?: string;
}

export async function handleAddTarget(options: AddTargetOptions): Promise<AddTargetResult> {
  // Validate name
  const nameResult = DeploymentTargetNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { success: false, error: nameResult.error.issues[0]?.message ?? 'Invalid target name' };
  }

  // Validate account
  const accountResult = AwsAccountIdSchema.safeParse(options.account);
  if (!accountResult.success) {
    return { success: false, error: accountResult.error.issues[0]?.message ?? 'Invalid AWS account ID' };
  }

  // Validate region
  const regionResult = AgentCoreRegionSchema.safeParse(options.region);
  if (!regionResult.success) {
    return { success: false, error: `Invalid region: ${options.region}` };
  }

  try {
    const configBaseDir = findConfigRoot();
    if (!configBaseDir) {
      return { success: false, error: new NoProjectError().message };
    }

    const configIO = new ConfigIO({ baseDir: configBaseDir });

    // Read existing targets
    let targets: AwsDeploymentTarget[] = [];
    if (configIO.configExists('awsTargets')) {
      targets = await configIO.readAWSDeploymentTargets();
    }

    // Check for duplicate
    if (targets.some(t => t.name === options.name)) {
      return { success: false, error: `Target '${options.name}' already exists` };
    }

    // Create and append target
    const newTarget: AwsDeploymentTarget = {
      name: options.name,
      account: options.account,
      region: options.region as AwsDeploymentTarget['region'],
      ...(options.description && { description: options.description }),
    };
    targets.push(newTarget);

    await configIO.writeAWSDeploymentTargets(targets);

    return { success: true };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
