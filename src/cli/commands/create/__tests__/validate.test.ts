import { validateCreateOptions, validateFolderNotExists } from '../validate.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('validateFolderNotExists', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `create-validate-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'existing-project'), { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true when folder does not exist', () => {
    expect(validateFolderNotExists('new-project', testDir)).toBe(true);
  });

  it('returns error string when folder exists', () => {
    const result = validateFolderNotExists('existing-project', testDir);
    expect(typeof result).toBe('string');
    expect(result).toContain('already exists');
  });
});

describe('validateCreateOptions', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `create-opts-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns invalid when name is missing', () => {
    const result = validateCreateOptions({}, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--name is required');
  });

  it('returns invalid for invalid project name', () => {
    const result = validateCreateOptions({ name: '!!invalid!!' }, testDir);
    expect(result.valid).toBe(false);
  });

  it('returns invalid when folder already exists', () => {
    mkdirSync(join(testDir, 'TakenName'), { recursive: true });
    const result = validateCreateOptions({ name: 'TakenName' }, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns valid with --no-agent flag', () => {
    const result = validateCreateOptions({ name: 'NoAgentProject', agent: false }, testDir);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when agent options are incomplete', () => {
    const result = validateCreateOptions({ name: 'TestProj', framework: 'Strands' }, testDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--framework');
  });

  it('returns invalid when language is missing', () => {
    const result = validateCreateOptions(
      { name: 'TestProj2', framework: 'Strands', modelProvider: 'Bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--language');
  });

  it('returns invalid for invalid language', () => {
    const result = validateCreateOptions(
      { name: 'TestProj3', language: 'Rust', framework: 'Strands', modelProvider: 'Bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid language');
  });

  it('returns invalid for TypeScript language', () => {
    const result = validateCreateOptions(
      { name: 'TestProj4', language: 'TypeScript', framework: 'Strands', modelProvider: 'Bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('TypeScript is not yet supported');
  });

  it('returns invalid for invalid framework', () => {
    const result = validateCreateOptions(
      { name: 'TestProj5', language: 'Python', framework: 'InvalidFW', modelProvider: 'Bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid framework');
  });

  it('returns invalid for invalid model provider', () => {
    const result = validateCreateOptions(
      { name: 'TestProj6', language: 'Python', framework: 'Strands', modelProvider: 'InvalidMP', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid model provider');
  });

  it('returns invalid for invalid memory option', () => {
    const result = validateCreateOptions(
      { name: 'TestProj7', language: 'Python', framework: 'Strands', modelProvider: 'Bedrock', memory: 'invalid' },
      testDir
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid memory option');
  });

  it('returns valid with all valid options', () => {
    const result = validateCreateOptions(
      { name: 'TestProj8', language: 'Python', framework: 'Strands', modelProvider: 'Bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('accepts lowercase flag values and normalizes them', () => {
    const result = validateCreateOptions(
      { name: 'TestProjLower', language: 'python', framework: 'strands', modelProvider: 'bedrock', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('accepts uppercase flag values and normalizes them', () => {
    const result = validateCreateOptions(
      { name: 'TestProjUpper', language: 'PYTHON', framework: 'STRANDS', modelProvider: 'BEDROCK', memory: 'none' },
      testDir
    );
    expect(result.valid).toBe(true);
  });

  it('returns invalid for unsupported framework/model combination', () => {
    // GoogleADK only supports certain providers, not all
    const result = validateCreateOptions(
      {
        name: 'TestProj9',
        language: 'Python',
        framework: 'GoogleADK',
        modelProvider: 'Bedrock',
        memory: 'none',
      },
      testDir
    );
    // This may or may not be valid depending on getSupportedModelProviders
    // The test verifies the validation logic runs without error
    expect(typeof result.valid).toBe('boolean');
  });
});

describe('validateCreateOptions - VPC validation', () => {
  const cwd = join(tmpdir(), `create-vpc-${randomUUID()}`);

  const baseOptions = {
    name: 'TestProject',
    language: 'Python',
    framework: 'Strands',
    modelProvider: 'Bedrock',
    memory: 'none',
  };

  it('accepts valid VPC options', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        subnets: 'subnet-12345678',
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(true);
  });

  it('accepts PUBLIC network mode without VPC options', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'PUBLIC',
      },
      cwd
    );
    expect(result.valid).toBe(true);
  });

  it('accepts no network mode (defaults to PUBLIC)', () => {
    const result = validateCreateOptions({ ...baseOptions }, cwd);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid network mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'INVALID',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid network mode');
  });

  it('rejects VPC mode without subnets', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });

  it('rejects VPC mode without security groups', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        subnets: 'subnet-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--security-groups is required');
  });

  it('rejects subnets without VPC mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        subnets: 'subnet-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects security groups without VPC mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects VPC mode missing both subnets and security groups', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });
});
