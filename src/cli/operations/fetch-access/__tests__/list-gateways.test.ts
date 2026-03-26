import { listGateways } from '../list-gateways';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib', () => ({
  ConfigIO: vi.fn(),
}));

function createMockConfigIO(deployedState: any, projectSpec: any) {
  return {
    readDeployedState: vi.fn().mockResolvedValue(deployedState),
    readProjectSpec: vi.fn().mockResolvedValue(projectSpec),
  } as any;
}

const deployedState = {
  targets: {
    default: {
      resources: {
        mcp: {
          gateways: {
            'gw-jwt': { gatewayId: 'id1', gatewayArn: 'arn1', gatewayUrl: 'https://jwt.example.com' },
            'gw-iam': { gatewayId: 'id2', gatewayArn: 'arn2', gatewayUrl: 'https://iam.example.com' },
            'gw-none': { gatewayId: 'id3', gatewayArn: 'arn3', gatewayUrl: 'https://none.example.com' },
            'gw-no-url': { gatewayId: 'id4', gatewayArn: 'arn4' },
          },
        },
      },
    },
  },
};

const projectSpec = {
  agentCoreGateways: [
    {
      name: 'gw-jwt',
      targets: [],
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
          allowedClients: ['client1'],
        },
      },
    },
    { name: 'gw-iam', targets: [], authorizerType: 'AWS_IAM' },
    { name: 'gw-none', targets: [], authorizerType: 'NONE' },
    { name: 'gw-no-url', targets: [], authorizerType: 'NONE' },
    { name: 'gw-not-deployed', targets: [], authorizerType: 'NONE' },
  ],
};

describe('listGateways', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns gateways with correct auth types when multiple are deployed with gatewayUrl', async () => {
    const configIO = createMockConfigIO(deployedState, projectSpec);

    const result = await listGateways({ configIO });

    expect(result).toEqual([
      { name: 'gw-jwt', authType: 'CUSTOM_JWT' },
      { name: 'gw-iam', authType: 'AWS_IAM' },
      { name: 'gw-none', authType: 'NONE' },
    ]);
  });

  it('filters out gateways that have no gatewayUrl in deployed state', async () => {
    const configIO = createMockConfigIO(deployedState, projectSpec);

    const result = await listGateways({ configIO });

    expect(result.find(g => g.name === 'gw-no-url')).toBeUndefined();
  });

  it('filters out gateways that are not present in deployed state at all', async () => {
    const configIO = createMockConfigIO(deployedState, projectSpec);

    const result = await listGateways({ configIO });

    expect(result.find(g => g.name === 'gw-not-deployed')).toBeUndefined();
  });

  it('returns empty array when deployed-state has no targets', async () => {
    const configIO = createMockConfigIO({ targets: {} }, projectSpec);

    const result = await listGateways({ configIO });

    expect(result).toEqual([]);
  });

  it('returns empty array when the specified deployTarget does not exist', async () => {
    const configIO = createMockConfigIO(deployedState, projectSpec);

    const result = await listGateways({ configIO, deployTarget: 'nonexistent' });

    expect(result).toEqual([]);
  });

  it('uses the specified deployTarget instead of the first target', async () => {
    const stateWithTwoTargets = {
      targets: {
        default: {
          resources: {
            mcp: {
              gateways: {
                'gw-jwt': { gatewayId: 'id1', gatewayArn: 'arn1', gatewayUrl: 'https://jwt.example.com' },
              },
            },
          },
        },
        staging: {
          resources: {
            mcp: {
              gateways: {
                'gw-iam': { gatewayId: 'id2', gatewayArn: 'arn2', gatewayUrl: 'https://iam.example.com' },
              },
            },
          },
        },
      },
    };
    const configIO = createMockConfigIO(stateWithTwoTargets, projectSpec);

    const result = await listGateways({ configIO, deployTarget: 'staging' });

    expect(result).toEqual([{ name: 'gw-iam', authType: 'AWS_IAM' }]);
  });
});
