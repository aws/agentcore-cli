/**
 * Push local dataset file to service DRAFT using incremental diff.
 *
 * Algorithm:
 * 1. Read local JSONL file
 * 2. Download remote DRAFT via pre-signed URL
 * 3. Diff by exampleId
 * 4. Delete removed, update changed, add new
 * 5. Write back exampleIds to local file
 */
import {
  addDatasetExamples,
  deleteDatasetExamples,
  downloadDataset,
  getDataset,
  updateDatasetExamples,
} from '../../aws/agentcore-datasets';
import { isRetryableAwsError } from '../../aws/retry';
import { waitForDatasetActive } from './wait';
import stableStringify from 'fast-json-stable-stringify';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Maximum examples per API call (service limit). */
const API_BATCH_LIMIT = 1000;

export interface PushOptions {
  region: string;
  datasetId: string;
  localFilePath: string;
  configBaseDir: string;
  force?: boolean;
}

export interface PushResult {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  totalRemote: number;
}

interface ParsedExample {
  exampleId?: string;
  content: Record<string, unknown>;
  lineIndex: number;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a JSONL file into structured examples with line index tracking.
 * @throws Error with line number context if any line contains invalid JSON.
 */
function parseLocalFile(content: string): ParsedExample[] {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const exampleId = obj.exampleId as string | undefined;
      return { exampleId, content: obj, lineIndex: index };
    } catch (err) {
      throw new Error(
        `Invalid JSON at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}\n` +
          `  ${line.length > 120 ? line.slice(0, 120) + '...' : line}`
      );
    }
  });
}

/**
 * Parse remote JSONL (from download URL) into a map of exampleId → full content object.
 */
function parseRemoteJsonl(content: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const lines = content.split('\n').filter(line => line.trim() !== '');
  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const exampleId = obj.exampleId as string;
    if (exampleId) {
      map.set(exampleId, obj);
    }
  }
  return map;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip exampleId from an object, returning remaining fields.
 * Used when submitting examples to the API (service assigns its own IDs)
 * and when comparing content equality (ID is not part of the content).
 */
function stripExampleId(obj: Record<string, unknown>): Record<string, unknown> {
  const { exampleId: _, ...rest } = obj;
  return rest;
}

/**
 * Compare two examples for equality (ignoring exampleId field).
 * Uses `fast-json-stable-stringify` for deterministic, key-order-independent serialization so
 * server-reordered examples don't appear as false-positive updates.
 */
function contentEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableStringify(stripExampleId(a)) === stableStringify(stripExampleId(b));
}

/** Max retry attempts for a single batch on transient AWS errors. */
const BATCH_MAX_RETRIES = 3;
/** Base exponential-backoff delay (doubled each attempt). */
const BATCH_RETRY_BASE_MS = 1_000;

/**
 * Run an async operation with bounded retry on transient AWS errors.
 * Retries on throttling / 5xx / 429; surfaces 4xx client errors immediately.
 * The operation should carry its own idempotency token so retries are safe.
 */
async function withRetry<R>(op: () => Promise<R>): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BATCH_MAX_RETRIES; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === BATCH_MAX_RETRIES - 1 || !isRetryableAwsError(err)) throw err;
      await sleep(BATCH_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Execute a batched API operation with error context and retry.
 * Processes items in chunks of API_BATCH_LIMIT, waits for ACTIVE between batches,
 * retries each batch up to BATCH_MAX_RETRIES times with exponential backoff on
 * transient errors, and wraps final failures with progress information. A fresh
 * idempotency token is generated per batch and reused across its retries so the
 * service can dedupe.
 */
async function batchOperation<T, R>(options: {
  items: T[];
  operation: (batch: T[], clientToken: string) => Promise<R>;
  phaseName: string;
  region: string;
  datasetId: string;
  waitBetweenBatches?: boolean;
}): Promise<R[]> {
  const { items, operation, phaseName, region, datasetId, waitBetweenBatches = true } = options;
  if (items.length === 0) return [];

  const totalBatches = Math.ceil(items.length / API_BATCH_LIMIT);
  let completed = 0;
  const results: R[] = [];

  try {
    for (let i = 0; i < items.length; i += API_BATCH_LIMIT) {
      const batch = items.slice(i, i + API_BATCH_LIMIT);
      const clientToken = randomUUID();
      const result = await withRetry(() => operation(batch, clientToken));
      results.push(result);
      completed++;
      if (waitBetweenBatches && i + API_BATCH_LIMIT < items.length) {
        await waitForDatasetActive(region, datasetId);
      }
    }
  } catch (err) {
    throw new Error(
      `Push failed during ${phaseName} phase (${completed}/${totalBatches} batches completed). ` +
        `Re-run \`agentcore dataset push\` to retry and reconcile. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Write exampleIds back into the local JSONL file after push.
 * In force mode (no addedExamples), all examples get new IDs.
 * In incremental mode, only newly-added examples get IDs assigned.
 */
async function rewriteLocalFileWithIds(
  filePath: string,
  allExamples: ParsedExample[],
  newIds: string[],
  addedExamples?: ParsedExample[]
): Promise<void> {
  let newIdIndex = 0;
  const lines: string[] = [];

  for (const example of allExamples) {
    if (addedExamples?.includes(example)) {
      // Stale exampleId or new example — strip old ID and assign fresh one from API
      const content = stripExampleId(example.content);
      lines.push(JSON.stringify({ exampleId: newIds[newIdIndex++], ...content }));
    } else if (!addedExamples) {
      // Force mode — all examples get new IDs
      const content = stripExampleId(example.content);
      lines.push(JSON.stringify({ exampleId: newIds[newIdIndex++], ...content }));
    } else {
      // Unchanged or updated — keep existing content
      lines.push(JSON.stringify(example.content));
    }
  }

  await writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}

// ============================================================================
// Main
// ============================================================================

/**
 * Sync local dataset file to the service DRAFT using incremental diff.
 * In force mode, deletes all remote examples and re-adds from local.
 */
export async function pushDataset(options: PushOptions): Promise<PushResult> {
  const { region, datasetId, localFilePath, configBaseDir, force } = options;
  const absolutePath = resolve(configBaseDir, localFilePath);

  // Read local file
  const localContent = await readFile(absolutePath, 'utf8');
  const localExamples = parseLocalFile(localContent);

  // Download remote DRAFT (buffered — needed for in-memory diffing)
  const datasetInfo = await getDataset({ region, datasetId });
  let remoteMap = new Map<string, Record<string, unknown>>();
  if (datasetInfo.downloadUrl && datasetInfo.exampleCount > 0) {
    const remoteContent = await downloadDataset(datasetInfo.downloadUrl, { mode: 'buffer' });
    remoteMap = parseRemoteJsonl(remoteContent);
  }

  if (force) {
    // Force mode: delete all remote, re-add all local
    if (remoteMap.size > 0) {
      const remoteIds = Array.from(remoteMap.keys());
      await batchOperation({
        items: remoteIds,
        operation: (batch, clientToken) => deleteDatasetExamples({ region, datasetId, exampleIds: batch, clientToken }),
        phaseName: 'delete',
        region,
        datasetId,
      });
      await waitForDatasetActive(region, datasetId);
    }

    const examplesToAdd = localExamples.map(e => stripExampleId(e.content));
    const newIds: string[] = [];

    if (examplesToAdd.length > 0) {
      const results = await batchOperation({
        items: examplesToAdd,
        operation: (batch, clientToken) => addDatasetExamples({ region, datasetId, examples: batch, clientToken }),
        phaseName: 'add',
        region,
        datasetId,
      });
      for (const r of results) newIds.push(...r.exampleIds);
    }

    await rewriteLocalFileWithIds(absolutePath, localExamples, newIds);

    return {
      added: localExamples.length,
      updated: 0,
      deleted: remoteMap.size,
      unchanged: 0,
      totalRemote: localExamples.length,
    };
  }

  // Incremental diff mode
  const toAdd: ParsedExample[] = [];
  const toUpdate: ParsedExample[] = [];
  const localExampleIds = new Set<string>();
  let unchanged = 0;

  for (const local of localExamples) {
    if (local.exampleId && remoteMap.has(local.exampleId)) {
      // Exists in remote — check if content changed
      localExampleIds.add(local.exampleId);
      const remote = remoteMap.get(local.exampleId)!;
      if (contentEquals(local.content, remote)) {
        unchanged++;
      } else {
        toUpdate.push(local);
      }
    } else if (local.exampleId && !remoteMap.has(local.exampleId)) {
      // Stale exampleId (not in remote) — treat as new add
      toAdd.push(local);
    } else {
      // No exampleId — new example
      toAdd.push(local);
    }
  }

  // Remote examples not in local → delete
  const toDeleteIds: string[] = [];
  for (const remoteId of remoteMap.keys()) {
    if (!localExampleIds.has(remoteId)) {
      toDeleteIds.push(remoteId);
    }
  }

  // Execute: Delete → Update → Add
  if (toDeleteIds.length > 0) {
    await batchOperation({
      items: toDeleteIds,
      operation: (batch, clientToken) => deleteDatasetExamples({ region, datasetId, exampleIds: batch, clientToken }),
      phaseName: 'delete',
      region,
      datasetId,
    });
    await waitForDatasetActive(region, datasetId);
  }

  if (toUpdate.length > 0) {
    await batchOperation({
      items: toUpdate.map(e => e.content as { exampleId: string } & Record<string, unknown>),
      operation: (batch, clientToken) => updateDatasetExamples({ region, datasetId, examples: batch, clientToken }),
      phaseName: 'update',
      region,
      datasetId,
    });
    await waitForDatasetActive(region, datasetId);
  }

  const newIds: string[] = [];
  if (toAdd.length > 0) {
    const addExamples = toAdd.map(e => stripExampleId(e.content));
    const results = await batchOperation({
      items: addExamples,
      operation: (batch, clientToken) => addDatasetExamples({ region, datasetId, examples: batch, clientToken }),
      phaseName: 'add',
      region,
      datasetId,
    });
    for (const r of results) newIds.push(...r.exampleIds);
  }

  // Write back new exampleIds to local file
  if (newIds.length > 0) {
    await rewriteLocalFileWithIds(absolutePath, localExamples, newIds, toAdd);
  }

  return {
    added: toAdd.length,
    updated: toUpdate.length,
    deleted: toDeleteIds.length,
    unchanged,
    totalRemote: localExamples.length,
  };
}
