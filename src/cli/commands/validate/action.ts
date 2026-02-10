import {
  ConfigIO,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  NoProjectError,
  findConfigRoot,
} from '../../../lib';

export interface ValidateOptions {
  directory?: string;
}

export interface ValidateResult {
  success: boolean;
  error?: string;
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
  try {
    await configIO.readProjectSpec();
  } catch (err) {
    return { success: false, error: formatError(err, 'agentcore.json') };
  }

  // Validate AWS targets (aws-targets.json)
  try {
    await configIO.readAWSDeploymentTargets();
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

  return { success: true };
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
