import { validateCreateHarnessOptions } from '../harness-validate.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('validateCreateHarnessOptions', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `harness-create-validate-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'existingHarness'), { recursive: true });
    mkdirSync(join(testDir, 'existingProject'), { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('requires name', () => {
    const result = validateCreateHarnessOptions({}, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--name');
  });

  it('rejects invalid harness name starting with digit', () => {
    const result = validateCreateHarnessOptions({ name: '1invalid' }, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('letter');
  });

  it('rejects invalid harness name with special characters', () => {
    const result = validateCreateHarnessOptions({ name: 'invalid-name!' }, testDir);
    expect(result.valid).toBe(false);
  });

  it('rejects existing directory', () => {
    const result = validateCreateHarnessOptions({ name: 'existingHarness' }, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('accepts valid bedrock options with defaults', () => {
    const result = validateCreateHarnessOptions({ name: 'myHarness' }, testDir);
    expect(result.valid).toBe(true);
  });

  it('accepts explicit model provider and id', () => {
    const result = validateCreateHarnessOptions(
      {
        name: 'myHarness2',
        modelProvider: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
      },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('requires api-key-arn for non-bedrock providers', () => {
    const result = validateCreateHarnessOptions(
      {
        name: 'myHarness3',
        modelProvider: 'open_ai',
        modelId: 'gpt-4',
      },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--api-key-arn');
  });

  it('accepts non-bedrock provider with api-key-arn', () => {
    const result = validateCreateHarnessOptions(
      {
        name: 'myHarness4',
        modelProvider: 'open_ai',
        modelId: 'gpt-4',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-key',
      },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('normalizes titlecase model provider to lowercase', () => {
    const options: any = {
      name: 'myHarness5',
      modelProvider: 'Bedrock',
      modelId: 'test-model',
    };
    const result = validateCreateHarnessOptions(options, testDir);
    expect(result.valid).toBe(true);
    expect(options.modelProvider).toBe('bedrock');
  });

  it('normalizes OpenAI to open_ai', () => {
    const options: any = {
      name: 'myHarness6',
      modelProvider: 'OpenAI',
      modelId: 'gpt-4',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-key',
    };
    const result = validateCreateHarnessOptions(options, testDir);
    expect(result.valid).toBe(true);
    expect(options.modelProvider).toBe('open_ai');
  });

  it('normalizes Gemini to gemini', () => {
    const options: any = {
      name: 'myHarness7',
      modelProvider: 'Gemini',
      modelId: 'gemini-pro',
      apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-key',
    };
    const result = validateCreateHarnessOptions(options, testDir);
    expect(result.valid).toBe(true);
    expect(options.modelProvider).toBe('gemini');
  });

  it('rejects invalid model provider', () => {
    const result = validateCreateHarnessOptions(
      {
        name: 'myHarness8',
        modelProvider: 'azure',
        modelId: 'test-model',
      },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('provider');
  });

  it('applies default model provider and id', () => {
    const options: any = { name: 'myHarness9' };
    const result = validateCreateHarnessOptions(options, testDir);
    expect(result.valid).toBe(true);
    expect(options.modelProvider).toBe('bedrock');
    expect(options.modelId).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it('accepts valid harness name with underscores when project-name is valid', () => {
    const result = validateCreateHarnessOptions(
      { name: 'my_valid_harness_123', projectName: 'myValidHarness123' },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('rejects harness name longer than 48 characters', () => {
    const result = validateCreateHarnessOptions({ name: 'a'.repeat(49) }, testDir);
    expect(result.valid).toBe(false);
  });

  it('allows long harness name when project-name is valid', () => {
    const result = validateCreateHarnessOptions(
      { name: `Harness${'A'.repeat(30)}`, projectName: 'ShortProject' },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('validates project-name separately from harness name', () => {
    const result = validateCreateHarnessOptions(
      { name: 'ValidHarness', projectName: 'ProjectNameTooLongForCli' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Project name');
  });

  it('checks folder existence using project-name', () => {
    const result = validateCreateHarnessOptions({ name: 'ValidHarness2', projectName: 'existingProject' }, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('existingProject');
  });
});
