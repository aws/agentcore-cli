import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadDeployedState } = vi.hoisted(() => ({
  mockReadDeployedState: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readDeployedState = mockReadDeployedState;
  },
}));

const { getPaymentEnvVars } = await import('../payment-env.js');

describe('getPaymentEnvVars', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty object when readDeployedState throws', async () => {
    mockReadDeployedState.mockRejectedValue(new Error('not found'));
    const result = await getPaymentEnvVars();
    expect(result).toEqual({});
  });

  it('generates MANAGER_ARN, PROCESS_PAYMENT_ROLE_ARN, and CONNECTOR_ID for a single manager', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'my-payment': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/my-payment',
                processPaymentRoleArn: 'arn:aws:iam::123:role/ProcessPaymentRole',
                connectors: {
                  'coinbase-connector': {
                    connectorId: 'conn-abc123',
                    credentialProviderName: 'my-cdp-cred',
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = await getPaymentEnvVars();

    expect(result).toEqual({
      AGENTCORE_PAYMENT_MY_PAYMENT_MANAGER_ARN: 'arn:aws:bedrock:us-east-1:123:payment-manager/my-payment',
      AGENTCORE_PAYMENT_MY_PAYMENT_PROCESS_PAYMENT_ROLE_ARN: 'arn:aws:iam::123:role/ProcessPaymentRole',
      AGENTCORE_PAYMENT_MY_PAYMENT_CONNECTOR_ID: 'conn-abc123',
    });
  });

  it('injects AUTH_MODE=bearer when authorizerType is CUSTOM_JWT', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'jwt-payment': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/jwt-payment',
                authorizerType: 'CUSTOM_JWT',
                connectors: {
                  'my-conn': { connectorId: 'conn-jwt' },
                },
              },
            },
          },
        },
      },
    });

    const result = await getPaymentEnvVars();

    expect(result.AGENTCORE_PAYMENT_JWT_PAYMENT_AUTH_MODE).toBe('bearer');
  });

  it('does NOT inject AUTH_MODE when authorizerType is AWS_IAM', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'iam-payment': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/iam-payment',
                authorizerType: 'AWS_IAM',
                connectors: {
                  'my-conn': { connectorId: 'conn-iam' },
                },
              },
            },
          },
        },
      },
    });

    const result = await getPaymentEnvVars();

    expect(result).not.toHaveProperty('AGENTCORE_PAYMENT_IAM_PAYMENT_AUTH_MODE');
  });

  it('exposes first connector ID at manager level for multiple connectors', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'multi-pay': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/multi-pay',
                connectors: {
                  'connector-one': {
                    connectorId: 'conn-001',
                  },
                  'connector-two': {
                    connectorId: 'conn-002',
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = await getPaymentEnvVars();

    expect(result.AGENTCORE_PAYMENT_MULTI_PAY_CONNECTOR_ID).toBe('conn-001');
    expect(result).not.toHaveProperty('AGENTCORE_PAYMENT_MULTI_PAY_CONNECTOR_ONE_CONNECTOR_ID');
    expect(result).not.toHaveProperty('AGENTCORE_PAYMENT_MULTI_PAY_CONNECTOR_TWO_CONNECTOR_ID');
  });

  it('does not inject PROCESS_PAYMENT_ROLE_ARN when it is missing', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'no-role-pay': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/no-role-pay',
                connectors: {
                  'my-conn': { connectorId: 'conn-norole' },
                },
              },
            },
          },
        },
      },
    });

    const result = await getPaymentEnvVars();

    expect(result).not.toHaveProperty('AGENTCORE_PAYMENT_NO_ROLE_PAY_PROCESS_PAYMENT_ROLE_ARN');
    // Ensure no "undefined" string values leaked in
    for (const value of Object.values(result)) {
      expect(value).not.toBe('undefined');
    }
  });

  it('injects autoPayment, paymentToolAllowlist, and networkPreferences when set', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            payments: {
              'config-pay': {
                managerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/config-pay',
                autoPayment: true,
                paymentToolAllowlist: ['pay_tool_a', 'pay_tool_b'],
                networkPreferences: ['eip155:84532', 'eip155:1'],
                connectors: {
                  'my-conn': { connectorId: 'conn-cfg' },
                },
              },
            },
          },
        },
      },
    });

    const result = await getPaymentEnvVars();

    expect(result.AGENTCORE_PAYMENT_CONFIG_PAY_AUTO_PAYMENT).toBe('true');
    expect(result.AGENTCORE_PAYMENT_CONFIG_PAY_TOOL_ALLOWLIST).toBe('pay_tool_a,pay_tool_b');
    expect(result.AGENTCORE_PAYMENT_CONFIG_PAY_NETWORK_PREFERENCES).toBe('eip155:84532,eip155:1');
  });
});
