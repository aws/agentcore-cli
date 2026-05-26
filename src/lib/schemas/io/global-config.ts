import { toError } from '../../errors/types.js';
import type { Result } from '../../result.js';
import { readFileSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

export const GLOBAL_CONFIG_DIR = process.env.AGENTCORE_CONFIG_DIR ?? join(homedir(), '.agentcore');
export const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

const GlobalConfigSchema = z
  .object({
    installationId: z.string().optional().catch(undefined),
    uvDefaultIndex: z.string().optional().catch(undefined),
    uvIndex: z.string().optional().catch(undefined),
    disableTransactionSearch: z.boolean().optional().catch(undefined),
    transactionSearchIndexPercentage: z.number().int().min(0).max(100).optional().catch(undefined),
    telemetry: z
      .object({
        enabled: z.boolean().optional().catch(undefined),
        endpoint: z.string().optional().catch(undefined),
        audit: z.boolean().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .passthrough();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export async function readGlobalConfig(configFile = GLOBAL_CONFIG_FILE): Promise<GlobalConfig> {
  try {
    const data = await readFile(configFile, 'utf-8');
    return GlobalConfigSchema.parse(JSON.parse(data));
  } catch {
    return {};
  }
}

export function readGlobalConfigSync(configFile = GLOBAL_CONFIG_FILE): GlobalConfig {
  try {
    const data = readFileSync(configFile, 'utf-8');
    return GlobalConfigSchema.parse(JSON.parse(data));
  } catch {
    return {};
  }
}

export type UpdateGlobalConfigResult = Result;
export type InstallationIdResult = Result<{ id: string; created: boolean }>;

export async function updateGlobalConfig(
  partial: GlobalConfig,
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<UpdateGlobalConfigResult> {
  // Read the existing config strictly: a missing file is fine (start fresh), but a
  // malformed file must not be silently overwritten with merged-in defaults.
  const existing = await loadConfigForUpdate(configFile);
  if (!existing.success) {
    return existing;
  }

  try {
    const merged: GlobalConfig = mergeConfig(existing.config, partial);
    await mkdir(configDir, { recursive: true });
    await writeFile(configFile, JSON.stringify(merged, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: new Error(`Failed to write config to ${configFile}: ${toError(error).message}`) };
  }
}

type LoadConfigResult = { success: true; config: GlobalConfig } | { success: false; error: Error };

/**
 * Reads the existing global config for an update. Distinguishes a missing file
 * (treated as an empty config) from a malformed one (read/parse/schema failure),
 * so the caller can avoid clobbering a config it could not understand.
 */
async function loadConfigForUpdate(configFile: string): Promise<LoadConfigResult> {
  const existingFile = await configFileExists(configFile);
  if (!existingFile.success) {
    return existingFile;
  }
  if (!existingFile.exists) {
    return { success: true, config: {} };
  }

  try {
    const data = await readFile(configFile, 'utf-8');
    return { success: true, config: GlobalConfigSchema.parse(JSON.parse(data)) };
  } catch (error) {
    const cause = toError(error);
    return {
      success: false,
      error: new Error(`Config at ${configFile} is malformed: ${cause.message}`, { cause }),
    };
  }
}

type ConfigFileExistsResult = { success: true; exists: boolean } | { success: false; error: Error };

async function configFileExists(path: string): Promise<ConfigFileExistsResult> {
  try {
    await stat(path);
    return { success: true, exists: true };
  } catch (error) {
    const cause = toError(error);
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: true, exists: false };
    }
    return { success: false, error: new Error(`Could not access config at ${path}: ${cause.message}`, { cause }) };
  }
}

function mergeConfig(target: GlobalConfig, source: GlobalConfig): GlobalConfig {
  return {
    ...target,
    ...source,
    ...(source.telemetry !== undefined && {
      telemetry: { ...target.telemetry, ...source.telemetry },
    }),
  };
}

/**
 * Returns the installationId, generating one if it doesn't exist yet.
 * `created: true` means this is the first run (ID was just generated).
 *
 * Note: concurrent first-run invocations may each generate a different ID;
 * the last write wins. This is acceptable - the ID only needs to be stable
 * after the first successful write, and CLI invocations are typically sequential.
 */
export async function getOrCreateInstallationId(
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<InstallationIdResult> {
  const existing = await loadConfigForUpdate(configFile);
  if (!existing.success) {
    return existing;
  }

  if (existing.config.installationId) {
    return { success: true, id: existing.config.installationId, created: false };
  }

  const id = randomUUID();
  const updateResult = await updateGlobalConfig({ installationId: id }, configDir, configFile);
  if (!updateResult.success) {
    return updateResult;
  }

  return { success: true, id, created: true };
}
