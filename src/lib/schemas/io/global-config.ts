import { toError } from '../../errors/types';
import type { Result } from '../../result';
import { resilientParse } from '../../utils/zod.js';
import { readFileSync } from 'fs';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

export const GLOBAL_CONFIG_DIR = process.env.AGENTCORE_CONFIG_DIR ?? join(homedir(), '.agentcore');
export const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

const GlobalConfigSchemaStrict = z
  .object({
    installationId: z.string().uuid().optional(),
    uvDefaultIndex: z.string().optional(),
    uvIndex: z.string().optional(),
    disableTransactionSearch: z.boolean().optional(),
    transactionSearchIndexPercentage: z.number().int().min(0).max(100).optional(),
    telemetry: z
      .object({
        enabled: z.boolean().optional(),
        endpoint: z.string().optional(),
        audit: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GlobalConfig = z.infer<typeof GlobalConfigSchemaStrict>;

export function validateGlobalConfig(data: unknown): { success: boolean; error?: z.ZodError } {
  return GlobalConfigSchemaStrict.safeParse(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readGlobalConfig(configFile = GLOBAL_CONFIG_FILE): Promise<Result<{ config: GlobalConfig }>> {
  // Distinguish "file does not exist" (a normal first-run state) from "file
  // exists but cannot be read or parsed"
  try {
    await access(configFile, fsConstants.F_OK);
  } catch {
    return { success: true, config: {} };
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf-8'));
    if (!isRecord(parsed)) {
      return { success: false, error: new Error(`Config at ${configFile} is not a JSON object.`) };
    }
    return { success: true, config: resilientParse(GlobalConfigSchemaStrict, parsed) };
  } catch (err) {
    return { success: false, error: toError(err) };
  }
}

export function readGlobalConfigSync(configFile = GLOBAL_CONFIG_FILE): GlobalConfig {
  try {
    const data = readFileSync(configFile, 'utf-8');
    return resilientParse(GlobalConfigSchemaStrict, JSON.parse(data) as Record<string, unknown>);
  } catch {
    return {};
  }
}

export async function updateGlobalConfig(
  partial: GlobalConfig,
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<boolean> {
  const existing = await readGlobalConfig(configFile);
  if (!existing.success) {
    return false;
  }
  try {
    const merged: GlobalConfig = mergeConfig(existing.config, partial);
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
 * Returns the installationId, generating one if it doesn't exist yet or if the
 * persisted value is not a valid UUID.
 *
 * Note: concurrent first-run invocations may each generate a different id;
 * the last write wins. The id only needs to be stable after the first
 * successful write, and CLI invocations are typically sequential.
 */
export async function getOrCreateInstallationId(
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<Result<{ id: string; created: boolean }>> {
  const read = await readGlobalConfig(configFile);
  if (!read.success) return read;
  if (read.config.installationId) {
    return { success: true, id: read.config.installationId, created: false };
  }
  const id = randomUUID();
  const written = await updateGlobalConfig({ installationId: id }, configDir, configFile);
  if (!written) {
    return { success: false, error: new Error(`Failed to persist installation id to ${configFile}`) };
  }
  return { success: true, id, created: true };
}
