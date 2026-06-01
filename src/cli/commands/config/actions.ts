import {
  GLOBAL_CONFIG_FILE,
  readGlobalConfig,
  updateGlobalConfig,
  validateGlobalConfig,
} from '../../../lib/schemas/io/global-config.js';
import type { ConfigResult } from './types.js';
import { ValidationError } from '@/lib/index.js';

export async function handleConfigList(): Promise<ConfigResult> {
  const read = await readGlobalConfig();
  if (!read.success) {
    return { success: false, error: new Error(`Error: Unable to parse config file at ${GLOBAL_CONFIG_FILE}`) };
  }
  return { success: true, message: JSON.stringify(read.config, null, 2) };
}

export async function handleConfigGet(key: string): Promise<ConfigResult> {
  const read = await readGlobalConfig();
  if (!read.success) {
    return { success: false, error: new Error(`Error: Unable to parse config file at ${GLOBAL_CONFIG_FILE}`) };
  }
  const value = getByPath(read.config, key);
  if (value === undefined) {
    return { success: false, error: new Error(`Key "${key}" is not set.`) };
  }
  const message = JSON.stringify(value, null, 2);
  return { success: true, message };
}

export async function handleConfigSet(key: string, raw: string): Promise<ConfigResult> {
  const value = parseValue(raw);
  const partial = buildNestedObject(key, value);
  const validation = validateGlobalConfig(partial);

  if (!validation.success) {
    return { success: false, error: new ValidationError(`Invalid value "${raw}" for key "${key}".`) };
  }

  const ok = await updateGlobalConfig(partial);
  if (!ok) {
    return { success: false, error: new Error(`Error: Unable to write config file at ${GLOBAL_CONFIG_FILE}`) };
  }
  return { success: true, message: `Set ${key} = ${raw}` };
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function buildNestedObject(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const leaf = parts.pop();
  if (!leaf) return {};
  const result: Record<string, unknown> = {};
  const inner = parts.reduce<Record<string, unknown>>((acc, part) => {
    const next: Record<string, unknown> = {};
    acc[part] = next;
    return next;
  }, result);
  inner[leaf] = value;
  return result;
}
