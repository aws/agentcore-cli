import { ENV_FILE } from '../constants';
import { findConfigRoot } from '../schemas/io/path-resolver';
import { parse } from 'dotenv';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Get the path to agentcore/.env.local.
 * @param configRoot - Optional config root, defaults to finding it automatically
 */
export function getEnvPath(configRoot?: string): string {
  const root = configRoot ?? findConfigRoot();
  if (!root) throw new Error('Could not find agentcore directory');
  return join(root, ENV_FILE);
}

/**
 * Read agentcore/.env.local.
 */
export async function readEnvFile(configRoot?: string): Promise<Record<string, string>> {
  const path = getEnvPath(configRoot);
  if (!existsSync(path)) return {};
  return parse(await readFile(path, 'utf-8'));
}

/**
 * Get a single value from agentcore/.env.local.
 */
export async function getEnvVar(key: string, configRoot?: string): Promise<string | undefined> {
  return (await readEnvFile(configRoot))[key];
}

/**
 * Write to agentcore/.env.local. Merges with existing values by default.
 */
export async function writeEnvFile(updates: Record<string, string>, configRoot?: string, merge = true): Promise<void> {
  const path = getEnvPath(configRoot);
  const current = merge ? await readEnvFile(configRoot) : {};
  const env = { ...current, ...updates };

  const content =
    Object.entries(env)
      .map(([k, v]) => {
        if (v === undefined || v === null) return '';
        if (!/^[a-z_][a-z0-9_]*$/i.test(k)) throw new Error(`Invalid env key: ${k}`);

        const val = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

        return `${k}="${val}"`;
      })
      .filter(Boolean)
      .join('\n') + '\n';

  await writeFile(path, content);
}

/**
 * Set a single value in agentcore/.env.local.
 */
export async function setEnvVar(key: string, value: string, configRoot?: string): Promise<void> {
  await writeEnvFile({ [key]: value }, configRoot);
}

/**
 * Remove keys from agentcore/.env.local.
 */
export async function removeEnvVars(keys: string[], configRoot?: string): Promise<void> {
  const path = getEnvPath(configRoot);
  const current = await readEnvFile(configRoot);
  for (const key of keys) {
    delete current[key];
  }
  const entries = Object.entries(current);
  const content =
    entries.length > 0
      ? entries
          .map(
            ([k, v]) =>
              `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
          )
          .join('\n') + '\n'
      : '';
  await writeFile(path, content);
}
