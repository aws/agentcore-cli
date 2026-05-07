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
  /**
   * MCP runtime tools deployed as AgentCore Runtime compute. The Python
   * version lives at `compute.runtime.pythonVersion`.
   */
  mcpRuntimeTools?: Array<{
    name: string;
    compute?: {
      host?: string;
      runtime?: { pythonVersion?: string };
      pythonVersion?: string;
    };
  }>;
  /**
   * MCP gateways with Lambda or AgentCoreRuntime compute targets. Lambda
   * targets carry pythonVersion directly on the compute; AgentCoreRuntime
   * targets carry it under `compute.runtime.pythonVersion`.
   */
  agentCoreGateways?: Array<{
    name: string;
    targets?: Array<{
      name?: string;
      compute?: {
        host?: string;
        runtime?: { pythonVersion?: string };
        pythonVersion?: string;
      };
    }>;
  }>;
}

interface AwsTargetForWarnings {
  region: string;
}

/**
 * Extracts the Python runtime version (if any) from a compute config object,
 * regardless of host shape (Lambda's flat `pythonVersion` or AgentCoreRuntime's
 * nested `runtime.pythonVersion`).
 */
function getPythonVersionFromCompute(
  compute: { runtime?: { pythonVersion?: string }; pythonVersion?: string } | undefined
): string | undefined {
  if (!compute) return undefined;
  return compute.runtime?.pythonVersion ?? compute.pythonVersion;
}

/**
 * Returns a list of non-fatal validation warnings. Currently only checks
 * Python 3.14 region availability across agents, MCP runtime tools, and
 * gateway targets.
 */
export function collectRuntimeRegionWarnings(
  projectSpec: ProjectSpecForWarnings,
  awsTargets: readonly AwsTargetForWarnings[]
): string[] {
  const warnings: string[] = [];

  // Collect every component that selected PYTHON_3_14, with a friendly label
  // for the warning message.
  const py314Components: string[] = [];

  for (const r of projectSpec.runtimes ?? []) {
    if (r.runtimeVersion === 'PYTHON_3_14') py314Components.push(`agent "${r.name}"`);
  }

  for (const tool of projectSpec.mcpRuntimeTools ?? []) {
    if (getPythonVersionFromCompute(tool.compute) === 'PYTHON_3_14') {
      py314Components.push(`MCP tool "${tool.name}"`);
    }
  }

  for (const gw of projectSpec.agentCoreGateways ?? []) {
    for (const tgt of gw.targets ?? []) {
      if (getPythonVersionFromCompute(tgt.compute) === 'PYTHON_3_14') {
        const targetLabel = tgt.name ? `target "${tgt.name}"` : 'target';
        py314Components.push(`gateway "${gw.name}" ${targetLabel}`);
      }
    }
  }

  if (py314Components.length === 0) return warnings;

  const unsupportedRegions = Array.from(
    new Set(awsTargets.map(t => t.region).filter(region => !PYTHON_3_14_SUPPORTED_REGIONS.includes(region)))
  );

  if (unsupportedRegions.length === 0) return warnings;

  warnings.push(
    `Component(s) [${py314Components.join(', ')}] use Python 3.14, which is not yet ` +
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
