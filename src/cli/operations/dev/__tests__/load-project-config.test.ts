import { loadProjectConfig } from '../config.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockConfigExists = vi.fn();
const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    configExists = mockConfigExists;
  },
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
}));

describe('loadProjectConfig', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns null when no config root found', async () => {
    mockFindConfigRoot.mockReturnValue(null);
    expect(await loadProjectConfig('/work')).toBeNull();
  });

  it('returns null when project config does not exist', async () => {
    mockFindConfigRoot.mockReturnValue('/work/agentcore');
    mockConfigExists.mockReturnValue(false);
    expect(await loadProjectConfig('/work')).toBeNull();
  });

  it('returns project spec when valid', async () => {
    mockFindConfigRoot.mockReturnValue('/work/agentcore');
    mockConfigExists.mockReturnValue(true);
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    expect(await loadProjectConfig('/work')).toEqual({ name: 'Test', agents: [] });
  });

  it('returns null when readProjectSpec throws', async () => {
    mockFindConfigRoot.mockReturnValue('/work/agentcore');
    mockConfigExists.mockReturnValue(true);
    mockReadProjectSpec.mockRejectedValue(new Error('bad config'));
    expect(await loadProjectConfig('/work')).toBeNull();
  });
});
