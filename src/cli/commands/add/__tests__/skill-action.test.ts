import type { HarnessSpec } from '../../../../schema';
import { handleAddSkill } from '../skill-action.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadHarnessSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();
const mockReadProjectSpec = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readHarnessSpec = mockReadHarnessSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
    readProjectSpec = mockReadProjectSpec;
  },
}));

function makeHarnessSpec(overrides: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    name: 'TestHarness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' },
    tools: [],
    skills: [],
    ...overrides,
  } as HarnessSpec;
}

describe('handleAddSkill', () => {
  beforeEach(() => {
    mockReadHarnessSpec.mockReset();
    mockWriteHarnessSpec.mockReset();
    mockReadProjectSpec.mockReset();
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'my-git-cred', authorizerType: 'ApiKeyCredentialProvider' }],
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('adds a path skill to harness', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    const result = await handleAddSkill({ harness: 'TestHarness', path: './my-skill' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ path: './my-skill' }],
      })
    );
  });

  it('adds an S3 skill to harness', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    const result = await handleAddSkill({ harness: 'TestHarness', s3: 's3://bucket/skill' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ s3Uri: 's3://bucket/skill' }],
      })
    );
  });

  it('adds a git skill to harness', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    const result = await handleAddSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      gitPath: 'skills/foo',
    });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ gitUrl: 'https://github.com/org/repo', path: 'skills/foo' }],
      })
    );
  });

  it('adds a git skill with auth', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    const result = await handleAddSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      credentialName: 'my-git-cred',
      username: 'bot',
    });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ gitUrl: 'https://github.com/org/repo', auth: { credentialName: 'my-git-cred', username: 'bot' } }],
      })
    );
  });

  it('fails when no source type provided', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Exactly one');
  });

  it('fails when multiple source types provided', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', path: './x', s3: 's3://y' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Exactly one');
  });

  it('fails when harness not found', async () => {
    mockReadHarnessSpec.mockRejectedValue(new Error('not found'));
    const result = await handleAddSkill({ harness: 'Missing', path: './x' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('not found');
  });

  it('fails when s3 URI does not start with s3://', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', s3: 'bucket/skill' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('s3://');
  });

  it('fails when git URL does not start with https://', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', git: 'git@github.com:org/repo.git' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('https://');
  });

  it('rejects duplicate path skill', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec({ skills: [{ path: './my-skill' }] }));
    const result = await handleAddSkill({ harness: 'TestHarness', path: './my-skill' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('already exists');
  });

  it('rejects duplicate s3 skill', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec({ skills: [{ s3Uri: 's3://bucket/skill' }] }));
    const result = await handleAddSkill({ harness: 'TestHarness', s3: 's3://bucket/skill' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('already exists');
  });

  it('rejects duplicate git skill', async () => {
    mockReadHarnessSpec.mockResolvedValue(
      makeHarnessSpec({
        skills: [{ gitUrl: 'https://github.com/org/repo' }],
      })
    );
    const result = await handleAddSkill({ harness: 'TestHarness', git: 'https://github.com/org/repo' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('already exists');
  });

  it('rejects --git-path without --git', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', path: './x', gitPath: 'sub' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('--git');
  });

  it('rejects --credential without --git', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', path: './x', credentialName: 'my-cred' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('--git');
  });

  it('rejects --username without --git', async () => {
    const result = await handleAddSkill({ harness: 'TestHarness', path: './x', username: 'bot' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('--git');
  });

  it('rejects credential that does not exist in project', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    mockReadProjectSpec.mockResolvedValue({ credentials: [] });
    const result = await handleAddSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      credentialName: 'nonexistent',
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('not found in project');
  });

  it('rejects OAuth credential for git skill auth', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'my-oauth-cred', authorizerType: 'OAuthCredentialProvider' }],
    });
    const result = await handleAddSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      credentialName: 'my-oauth-cred',
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('ApiKeyCredentialProvider');
  });

  it('returns clean error when project config is unreadable', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec());
    mockReadProjectSpec.mockRejectedValue(new Error('Config file not found'));
    const result = await handleAddSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      credentialName: 'my-cred',
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Could not read project configuration');
  });
});
