import type { HarnessSpec } from '../../../../schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadHarnessSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readHarnessSpec = mockReadHarnessSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
  },
  findConfigRoot: vi.fn(() => '/fake/path'),
}));

function makeHarnessSpec(skills: HarnessSpec['skills'] = []): HarnessSpec {
  return {
    name: 'TestHarness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' },
    tools: [],
    skills,
  } as HarnessSpec;
}

describe('handleRemoveSkill', () => {
  beforeEach(() => {
    mockReadHarnessSpec.mockReset();
    mockWriteHarnessSpec.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('removes a path skill by matching value', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ path: './skill-a' }, { path: './skill-b' }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', path: './skill-a' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ path: './skill-b' }],
      })
    );
  });

  it('removes an s3 skill by matching value', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ s3Uri: 's3://bucket/skill' }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', s3: 's3://bucket/skill' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [],
      })
    );
  });

  it('removes a git skill by matching URL and path', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ gitUrl: 'https://github.com/org/repo', path: 'sub' }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({
      harness: 'TestHarness',
      git: 'https://github.com/org/repo',
      gitPath: 'sub',
    });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [],
      })
    );
  });

  it('removes a git skill without path by URL only', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ gitUrl: 'https://github.com/org/repo' }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', git: 'https://github.com/org/repo' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [],
      })
    );
  });

  it('removes an aws skill by matching paths', async () => {
    mockReadHarnessSpec.mockResolvedValue(
      makeHarnessSpec([{ awsSkills: { paths: ['core-skills/*'] } }, { path: './other' }])
    );
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', awsSkills: 'core-skills/*' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [{ path: './other' }],
      })
    );
  });

  it('removes an aws skill with no paths (wildcard)', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ awsSkills: {} }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', awsSkills: '*' });
    expect(result.success).toBe(true);
    expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
      'TestHarness',
      expect.objectContaining({
        skills: [],
      })
    );
  });

  it('fails when skill not found', async () => {
    mockReadHarnessSpec.mockResolvedValue(makeHarnessSpec([{ path: './other' }]));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', path: './missing' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('not found');
  });

  it('fails when no source provided', async () => {
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Exactly one');
  });

  it('fails when multiple sources provided', async () => {
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'TestHarness', path: './x', s3: 's3://y' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('Exactly one');
  });

  it('fails when harness not found', async () => {
    mockReadHarnessSpec.mockRejectedValue(new Error('not found'));
    const { handleRemoveSkill } = await import('../skill-command');
    const result = await handleRemoveSkill({ harness: 'Missing', path: './x' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.message).toContain('not found');
  });
});
