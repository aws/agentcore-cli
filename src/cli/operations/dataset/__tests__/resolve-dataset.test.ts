import { resolveDataset } from '../resolve-dataset.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockResolveAWSDeploymentTargets = vi.fn();
const mockReadDeployedState = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    resolveAWSDeploymentTargets = mockResolveAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
  },
}));

function makeDataset(name: string) {
  return {
    name,
    schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
    config: { managed: { location: `datasets/${name}.jsonl` } },
  };
}

describe('resolveDataset', () => {
  afterEach(() => vi.clearAllMocks());

  it('throws when no datasets in config', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [] });

    await expect(resolveDataset()).rejects.toThrow('No datasets found');
  });

  it('resolves by name when found', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [makeDataset('alpha'), makeDataset('beta')] });
    mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'us-east-1', name: 'default' }]);
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            datasets: {
              alpha: { datasetId: 'ds-alpha', datasetArn: 'arn:ds:alpha' },
            },
          },
        },
      },
    });

    const result = await resolveDataset('alpha');

    expect(result.name).toBe('alpha');
    expect(result.datasetId).toBe('ds-alpha');
    expect(result.region).toBe('us-east-1');
  });

  it('throws with available list when name not found', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [makeDataset('alpha'), makeDataset('beta')] });

    await expect(resolveDataset('nonexistent')).rejects.toThrow(/not found.*Available.*alpha.*beta/);
  });

  it('auto-selects when exactly one dataset and no name', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [makeDataset('only-one')] });
    mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'us-west-2', name: 'default' }]);
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            datasets: {
              'only-one': { datasetId: 'ds-only', datasetArn: 'arn:ds:only' },
            },
          },
        },
      },
    });

    const result = await resolveDataset();

    expect(result.name).toBe('only-one');
    expect(result.datasetId).toBe('ds-only');
  });

  it('throws "Specify --name" when multiple datasets and no name', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [makeDataset('a'), makeDataset('b')] });

    await expect(resolveDataset()).rejects.toThrow(/Multiple datasets.*Specify --name/);
  });

  it('throws when dataset has no deployed state', async () => {
    mockReadProjectSpec.mockResolvedValue({ datasets: [makeDataset('mine')] });
    mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'us-east-1', name: 'default' }]);
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            datasets: {},
          },
        },
      },
    });

    await expect(resolveDataset('mine')).rejects.toThrow('has not been deployed');
  });
});
