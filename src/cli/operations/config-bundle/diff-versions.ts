/**
 * Client-side deep diff between two config bundle version components.
 */

export interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Deep diff two JSON objects, returning a flat list of changes with dot-notation paths.
 */
export function deepDiff(from: unknown, to: unknown, prefix = ''): DiffEntry[] {
  const entries: DiffEntry[] = [];

  if (from === to) return entries;

  if (from === null || to === null || typeof from !== typeof to) {
    if (from === undefined) {
      entries.push({ path: prefix, type: 'added', newValue: to });
    } else if (to === undefined) {
      entries.push({ path: prefix, type: 'removed', oldValue: from });
    } else {
      entries.push({ path: prefix, type: 'changed', oldValue: from, newValue: to });
    }
    return entries;
  }

  if (typeof from !== 'object') {
    entries.push({ path: prefix, type: 'changed', oldValue: from, newValue: to });
    return entries;
  }

  if (Array.isArray(from) || Array.isArray(to)) {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) {
      entries.push({ path: prefix, type: 'changed', oldValue: from, newValue: to });
      return entries;
    }
    for (let i = 0; i < from.length; i++) {
      entries.push(...deepDiff(from[i], to[i], `${prefix}[${i}]`));
    }
    return entries;
  }

  const fromObj = from as Record<string, unknown>;
  const toObj = to as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(fromObj), ...Object.keys(toObj)]);

  for (const key of allKeys) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in fromObj)) {
      entries.push({ path: childPath, type: 'added', newValue: toObj[key] });
    } else if (!(key in toObj)) {
      entries.push({ path: childPath, type: 'removed', oldValue: fromObj[key] });
    } else {
      entries.push(...deepDiff(fromObj[key], toObj[key], childPath));
    }
  }

  return entries;
}
