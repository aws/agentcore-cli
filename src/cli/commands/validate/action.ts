import {
  ConfigIO,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  NoProjectError,
  findConfigRoot,
} from '../../../lib';
import { PYTHON_3_14_SUPPORTED_REGIONS } from '../../../schema';

export interface ValidateOptions {
  directory?: string;
}

export interface ValidateResult {
  success: boolean;
  error?: string;
  /**
   * Non-fatal warnings (e.g. selected runtime is not yet GA in the configured
   * region). The CLI prints these but does not fail validation.
   */
  warnings?: string[];
}

/**
 * Validates all AgentCore schema files in the project.
 * Returns a binary success/fail result with an error message if validation fails.
 */
export async function handleValidate(options: ValidateOptions): Promise<ValidateResult> {
  const baseDir = options.directory ?? process.cwd();

  // Check if project exists
  const configRoot = findConfigRoot(baseDir);
  if (!configRoot) {
    return {
      success: false,
      error: new NoProjectError().message,
    };
  }

  const configIO = new ConfigIO({ baseDir: configRoot });

  // Validate project spec (agentcore.json)
  let projectSpec: Awaited<ReturnType<ConfigIO['readProjectSpec']>>;
  try {
    projectSpec = await configIO.readProjectSpec();
  } catch (err) {
    return { success: false, error: formatError(err, 'agentcore.json') };
  }

  // Validate AWS targets (aws-targets.json)
  let awsTargets: Awaited<ReturnType<ConfigIO['readAWSDeploymentTargets']>>;
  try {
    awsTargets = await configIO.readAWSDeploymentTargets();
  } catch (err) {
    return { success: false, error: formatError(err, 'aws-targets.json') };
  }

  // Validate deployed state if it exists (.cli/state.json)
  if (configIO.configExists('state')) {
    try {
      await configIO.readDeployedState();
    } catch (err) {
      return { success: false, error: formatError(err, '.cli/state.json') };
    }
  }

  // Non-fatal warnings: PYTHON_3_14 is not GA in all regions; flag any agent
  // that selected it together with an unsupported region. See
  // https://github.com/aws/agentcore-cli/issues/907.
  const warnings = collectRuntimeRegionWarnings(projectSpec, awsTargets);

  return warnings.length > 0 ? { success: true, warnings } : { success: true };
}

interface ProjectSpecForWarnings {
  runtimes?: Array<{ name: string; runtimeVersion?: string }>;
}

interface AwsTargetForWarnings {
  region: string;
}

/**
 * Returns a list of non-fatal validation warnings. Currently only checks
 * Python 3.14 region availability.
 */
export function collectRuntimeRegionWarnings(
  projectSpec: ProjectSpecForWarnings,
  awsTargets: readonly AwsTargetForWarnings[]
): string[] {
  const warnings: string[] = [];

  const py314Agents = (projectSpec.runtimes ?? []).filter(r => r.runtimeVersion === 'PYTHON_3_14');
  if (py314Agents.length === 0) return warnings;

  const unsupportedRegions = awsTargets
    .map(t => t.region)
    .filter(region => !PYTHON_3_14_SUPPORTED_REGIONS.includes(region));

  if (unsupportedRegions.length === 0) return warnings;

  const agentNames = py314Agents.map(a => a.name).join(', ');
  warnings.push(
    `Agent(s) [${agentNames}] use runtimeVersion "PYTHON_3_14", which is not yet ` +
      `available in region(s): ${unsupportedRegions.join(', ')}. ` +
      `CloudFormation will reject the deployment with an early-validation error. ` +
      `Switch to "PYTHON_3_13" or deploy in one of: ${PYTHON_3_14_SUPPORTED_REGIONS.join(', ')}.`
  );

  return warnings;
}

function formatError(err: unknown, fileName: string): string {
  if (err instanceof ConfigValidationError) {
    return err.message;
  }
  if (err instanceof ConfigParseError) {
    return `Invalid JSON in ${fileName}: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`;
  }
  if (err instanceof ConfigReadError) {
    return `Failed to read ${fileName}: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`;
  }
  if (err instanceof ConfigNotFoundError) {
    return `Required file not found: ${fileName}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
