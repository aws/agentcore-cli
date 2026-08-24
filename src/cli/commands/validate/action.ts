import {
  ConfigIO,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  NoProjectError,
  SecureCredentials,
  findConfigRoot,
  readEnvFile,
} from '../../../lib';
import type { Result } from '../../../lib/result';
import { validateHarnessSpecs } from '../../operations/deploy/preflight';
import {
  computePaymentCredentialEnvVarNames,
  computeStripePrivyCredentialEnvVarNames,
} from '../../primitives/credential-utils';
import { existsSync } from 'fs';
import { join } from 'path';

export interface ValidateOptions {
  directory?: string;
}

/**
 * Validates all AgentCore schema files in the project.
 * Returns a binary success/fail result with an error message if validation fails.
 */
export async function handleValidate(options: ValidateOptions): Promise<Result> {
  const baseDir = options.directory ?? process.cwd();

  // Check if project exists
  const configRoot = findConfigRoot(baseDir);
  if (!configRoot) {
    return {
      success: false,
      error: new NoProjectError(),
    };
  }

  const configIO = new ConfigIO({ baseDir: configRoot });

  // Validate project spec (agentcore.json)
  let projectSpec;
  try {
    projectSpec = await configIO.readProjectSpec();
  } catch (err) {
    return { success: false, error: new Error(formatError(err, 'agentcore.json'), { cause: err }) };
  }

  // Validate payment credential completeness (local only, no network calls)
  if (projectSpec.payments && projectSpec.payments.length > 0) {
    for (const payment of projectSpec.payments) {
      if (payment.connectors.length === 0) {
        return {
          success: false,
          error: new Error(
            `Payment manager "${payment.name}" has no connectors. Add a connector with \`agentcore add payment-connector --manager ${payment.name}\``
          ),
        };
      }
      for (const connector of payment.connectors) {
        if (connector.provisionMode === 'QUICK_CREATE') continue;
        const credential = projectSpec.credentials?.find(c => c.name === connector.credentialName);
        if (!credential) {
          return {
            success: false,
            error: new Error(
              `Payment connector "${connector.name}" (manager "${payment.name}") references credential "${connector.credentialName}" which does not exist.`
            ),
          };
        }
        if (credential.authorizerType !== 'PaymentCredentialProvider') {
          return {
            success: false,
            error: new Error(
              `Payment connector "${connector.name}" references credential "${connector.credentialName}" with type "${credential.authorizerType}" — expected "PaymentCredentialProvider".`
            ),
          };
        }
        const connectorProvider = connector.provider ?? 'CoinbaseCDP';
        const credentialProvider = 'provider' in credential ? (credential as { provider: string }).provider : undefined;
        if (credentialProvider && credentialProvider !== connectorProvider) {
          return {
            success: false,
            error: new Error(
              `Payment connector "${connector.name}" uses provider "${connectorProvider}" but credential "${connector.credentialName}" is configured for "${credentialProvider}".`
            ),
          };
        }
      }
    }

    // Check .env.local has required variables
    const hasConnectors = projectSpec.payments.some(p => p.connectors.some(c => c.provisionMode !== 'QUICK_CREATE'));
    const envFilePath = join(configRoot, '.env.local');
    if (hasConnectors && !existsSync(envFilePath)) {
      const expectedVars: string[] = [];
      for (const payment of projectSpec.payments) {
        for (const connector of payment.connectors) {
          if (connector.provisionMode === 'QUICK_CREATE') continue;
          const provider = connector.provider ?? 'CoinbaseCDP';
          if (provider === 'StripePrivy') {
            const vars = computeStripePrivyCredentialEnvVarNames(connector.credentialName);
            expectedVars.push(vars.appId, vars.appSecret, vars.authorizationPrivateKey, vars.authorizationId);
          } else {
            const vars = computePaymentCredentialEnvVarNames(connector.credentialName);
            expectedVars.push(vars.apiKeyId, vars.apiKeySecret, vars.walletSecret);
          }
        }
      }
      return {
        success: false,
        error: new Error(
          `agentcore/.env.local not found. Payment credentials required:\n${expectedVars.map(v => `  ${v}`).join('\n')}\n\nRun 'agentcore add payment-connector --manager <name>' to set credentials interactively.`
        ),
      };
    }
    if (existsSync(envFilePath)) {
      try {
        const envVars = await readEnvFile(configRoot);
        const credentials = SecureCredentials.fromEnvVars(envVars);
        for (const payment of projectSpec.payments) {
          for (const connector of payment.connectors) {
            if (connector.provisionMode === 'QUICK_CREATE') continue;
            const provider = connector.provider ?? 'CoinbaseCDP';
            if (provider === 'StripePrivy') {
              const vars = computeStripePrivyCredentialEnvVarNames(connector.credentialName);
              const missing = [
                !credentials.get(vars.appId)?.trim() && vars.appId,
                !credentials.get(vars.appSecret)?.trim() && vars.appSecret,
                !credentials.get(vars.authorizationPrivateKey)?.trim() && vars.authorizationPrivateKey,
                !credentials.get(vars.authorizationId)?.trim() && vars.authorizationId,
              ].filter(Boolean);
              if (missing.length > 0) {
                return {
                  success: false,
                  error: new Error(
                    `Missing StripePrivy credentials for connector "${connector.name}" in .env.local: ${missing.join(', ')}`
                  ),
                };
              }
            } else {
              const vars = computePaymentCredentialEnvVarNames(connector.credentialName);
              const missing = [
                !credentials.get(vars.apiKeyId)?.trim() && vars.apiKeyId,
                !credentials.get(vars.apiKeySecret)?.trim() && vars.apiKeySecret,
                !credentials.get(vars.walletSecret)?.trim() && vars.walletSecret,
              ].filter(Boolean);
              if (missing.length > 0) {
                return {
                  success: false,
                  error: new Error(
                    `Missing CoinbaseCDP credentials for connector "${connector.name}" in .env.local: ${missing.join(', ')}`
                  ),
                };
              }
            }
          }
        }
      } catch (error) {
        return {
          success: false,
          error: new Error(
            `Failed to read .env.local: ${error instanceof Error ? error.message : String(error)}. Fix the file or re-run 'agentcore add payment-connector' to set credentials.`
          ),
        };
      }
    }
  }

  // Validate AWS targets (aws-targets.json)
  try {
    await configIO.readAWSDeploymentTargets();
  } catch (err) {
    return { success: false, error: new Error(formatError(err, 'aws-targets.json'), { cause: err }) };
  }

  // Validate deployed state if it exists (.cli/state.json)
  if (configIO.configExists('state')) {
    try {
      await configIO.readDeployedState();
    } catch (err) {
      return { success: false, error: new Error(formatError(err, '.cli/state.json'), { cause: err }) };
    }
  }

  // Validate each per-harness harness.json against HarnessSpecSchema. `validate` previously only
  // checked agentcore.json, so a malformed harness spec (bad model provider, missing
  // executionRoleArn, an out-of-CFN-bounds field) passed "validate" yet failed at deploy synth.
  // Reuse the deploy-preflight helper so `validate` and `deploy` aggregate the SAME way (report
  // every broken harness at once, not one-per-rerun).
  try {
    await validateHarnessSpecs(projectSpec, configRoot);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
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
