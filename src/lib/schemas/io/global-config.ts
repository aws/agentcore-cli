import { readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
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

export async function updateGlobalConfig(
  partial: GlobalConfig,
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<boolean> {
  try {
    const existing = await readGlobalConfig(configFile);
    const merged: GlobalConfig = mergeConfig(existing, partial);

    await mkdir(configDir, { recursive: true });
    await writeFile(configFile, JSON.stringify(merged, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
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
 * the last write wins. This is acceptable — the ID only needs to be stable
 * after the first successful write, and CLI invocations are typically sequential.
 */
export async function getOrCreateInstallationId(
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<{ id: string; created: boolean }> {
  const config = await readGlobalConfig(configFile);
  if (config.installationId) {
    return { id: config.installationId, created: false };
  }
  const id = randomUUID();
  await updateGlobalConfig({ installationId: id }, configDir, configFile);
  return { id, created: true };
}
