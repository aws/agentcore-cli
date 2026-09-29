import { loadDevEnv } from '../load-dev-env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFindConfigRoot, mockReadEnvFile, mockReadAWSDeploymentTargets } = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn(),
  mockReadEnvFile: vi.fn(),
  mockReadAWSDeploymentTargets: vi.fn(),
}));

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
  },
  findConfigRoot: mockFindConfigRoot,
  readEnvFile: mockReadEnvFile,
}));

vi.mock('../gateway-env.js', () => ({ getGatewayEnvVars: vi.fn().mockResolvedValue({}) }));
vi.mock('../memory-env.js', () => ({ getMemoryEnvVars: vi.fn().mockResolvedValue({}) }));
vi.mock('../payment-env.js', () => ({ getPaymentEnvVars: vi.fn().mockResolvedValue({}) }));

describe('loadDevEnv', () => {
  afterEach(() => vi.clearAllMocks());

  it('passes the configured deployment target region to the local runtime', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadEnvFile.mockResolvedValue({ AWS_REGION: 'us-west-2', PROJECT_VALUE: 'from-dotenv' });
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '123456789012', region: 'us-east-1' }]);

    const result = await loadDevEnv('/project');

    expect(result.envVars).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
      PROJECT_VALUE: 'from-dotenv',
    });
  });

  it('keeps working when deployment targets are not available yet', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadEnvFile.mockResolvedValue({ PROJECT_VALUE: 'from-dotenv' });
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('targets not found'));

    const result = await loadDevEnv('/project');

    expect(result.envVars).toEqual({ PROJECT_VALUE: 'from-dotenv' });
  });
});
