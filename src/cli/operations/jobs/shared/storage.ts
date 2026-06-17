/**
 * Pure file I/O for job records: `<configRoot>/.cli/jobs/{STORAGE_DIRS[type]}/{id}.json`.
 *
 * Hardened over the legacy per-type storage modules:
 *  - atomic writes (temp file + rename) so a killed process can't leave half-written JSON,
 *  - per-file parse guard in listRecords (one corrupt file is skipped, never crashes the list),
 *  - assertSafeId path-traversal guard, and content-`id` is authoritative over the filename.
 *
 * Legacy (pre-engine) records in the old shape are intentionally ignored (fresh start): any file
 * that doesn't parse to a current JobRecord (missing/mismatched `type`) is skipped by listRecords
 * and treated as not-found by loadRecord.
 */
import { CLI_SYSTEM_DIR, NoProjectError, findConfigRoot } from '../../../../lib';
import { STORAGE_DIRS } from './constants';
import type { JobRecord, JobType } from './types';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

function cliDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new NoProjectError();
  }
  return join(configRoot, CLI_SYSTEM_DIR);
}

function dirFor(type: JobType): string {
  return join(cliDir(), 'jobs', STORAGE_DIRS[type]);
}

function fileFor(type: JobType, id: string): string {
  return join(dirFor(type), `${id}.json`);
}

/** Reject ids that could escape the storage directory. */
export function assertSafeId(id: string): void {
  if (!id || /[/\\]/.test(id)) {
    throw new Error(`Invalid job id: must be non-empty and contain no path separators`);
  }
}

/** Is this parsed object a current-shape JobRecord for the expected type? */
function isJobRecordOfType(value: unknown, type: JobType): value is JobRecord {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Partial<JobRecord>;
  return rec.type === type && typeof rec.id === 'string' && rec.id.length > 0;
}

/** Persist a record atomically (temp file + rename). */
export function saveRecord(record: JobRecord): string {
  assertSafeId(record.id);
  const dir = dirFor(record.type);
  mkdirSync(dir, { recursive: true });

  const filePath = fileFor(record.type, record.id);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  renameSync(tmpPath, filePath);
  return filePath;
}

/** Load one record. Returns undefined if missing, unparseable, or a legacy/foreign shape. */
export function loadRecord<T extends JobType>(type: T, id: string): Extract<JobRecord, { type: T }> | undefined {
  assertSafeId(id);
  const filePath = fileFor(type, id);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (!isJobRecordOfType(parsed, type)) {
      return undefined; // legacy/foreign shape — ignored (fresh start)
    }
    return parsed as Extract<JobRecord, { type: T }>;
  } catch {
    return undefined; // corrupt file — treat as not found
  }
}

/** List records for one type (or all types). Skips corrupt/legacy files; never throws on a bad file. */
export function listRecords<T extends JobType>(type: T): Extract<JobRecord, { type: T }>[];
export function listRecords(type?: JobType): JobRecord[];
export function listRecords(type?: JobType): JobRecord[] {
  const types: JobType[] = type ? [type] : (Object.keys(STORAGE_DIRS) as JobType[]);
  const records: JobRecord[] = [];

  for (const t of types) {
    const dir = dirFor(t);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as unknown;
        if (isJobRecordOfType(parsed, t)) {
          records.push(parsed); // trust content `id`, not the filename
        }
      } catch {
        // skip corrupt/half-written file
      }
    }
  }
  return records;
}

/** Delete the local record file. Returns true if it existed and was removed. */
export function deleteRecord(type: JobType, id: string): boolean {
  assertSafeId(id);
  const filePath = fileFor(type, id);
  if (!existsSync(filePath)) {
    return false;
  }
  rmSync(filePath);
  return true;
}
