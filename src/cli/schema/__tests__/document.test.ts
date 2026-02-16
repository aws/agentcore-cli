import { loadSchemaDocument, saveSchemaDocument } from '../document.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const TestSchema = z.object({
  name: z.string(),
  value: z.number(),
});

describe('loadSchemaDocument', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-load-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid JSON with no validation error', async () => {
    const filePath = join(dir, 'valid.json');
    writeFileSync(filePath, JSON.stringify({ name: 'test', value: 42 }));

    const result = await loadSchemaDocument(filePath, TestSchema);

    expect(result.validationError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ name: 'test', value: 42 });
  });

  it('returns validation error for schema mismatch', async () => {
    const filePath = join(dir, 'bad-schema.json');
    writeFileSync(filePath, JSON.stringify({ name: 'test', value: 'not-a-number' }));

    const result = await loadSchemaDocument(filePath, TestSchema);

    expect(result.validationError).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it('returns validation error for invalid JSON', async () => {
    const filePath = join(dir, 'bad-json.json');
    writeFileSync(filePath, '{not valid json}');

    const result = await loadSchemaDocument(filePath, TestSchema);

    expect(result.validationError).toBeDefined();
  });

  it('throws when file does not exist', async () => {
    await expect(loadSchemaDocument(join(dir, 'missing.json'), TestSchema)).rejects.toThrow();
  });
});

describe('saveSchemaDocument', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-save-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves valid JSON and returns formatted content', async () => {
    const filePath = join(dir, 'save-valid.json');
    const content = JSON.stringify({ name: 'hello', value: 7 });

    const result = await saveSchemaDocument(filePath, content, TestSchema);

    expect(result.ok).toBe(true);
    expect(result.content).toBe(JSON.stringify({ name: 'hello', value: 7 }, null, 2));
    expect(readFileSync(filePath, 'utf-8')).toBe(result.content);
  });

  it('returns error for invalid JSON', async () => {
    const filePath = join(dir, 'save-bad-json.json');

    const result = await saveSchemaDocument(filePath, '{bad}', TestSchema);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for schema validation failure', async () => {
    const filePath = join(dir, 'save-bad-schema.json');
    const content = JSON.stringify({ name: 123, value: 'wrong' });

    const result = await saveSchemaDocument(filePath, content, TestSchema);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when write fails', async () => {
    // Try to write to a path under a non-existent directory
    const filePath = join(dir, 'no-such-dir', 'nested', 'file.json');
    const content = JSON.stringify({ name: 'test', value: 1 });

    const result = await saveSchemaDocument(filePath, content, TestSchema);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
