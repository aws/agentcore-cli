import { parsePaymentOutputs } from '../outputs.js';
import type { StackOutputs } from '../outputs.js';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutputs(name: string, overrides: Record<string, string> = {}): StackOutputs {
  return {
    [`Payment${name}ManagerArn`]: `arn:aws:bedrock:us-east-1:123456789012:payment-manager/${name}`,
    [`Payment${name}ManagerId`]: `pm-${name.toLowerCase()}-001`,
    [`Payment${name}ProcessPaymentRoleArn`]: `arn:aws:iam::123456789012:role/${name}ProcessPaymentRole`,
    [`Payment${name}ResourceRetrievalRoleArn`]: `arn:aws:iam::123456789012:role/${name}ResourceRetrievalRole`,
    ...overrides,
  };
}

const COINBASE_CREDENTIAL_ARN = 'arn:aws:bedrock:us-east-1:123456789012:credential-provider/coinbase';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parsePaymentOutputs', () => {
  describe('happy path', () => {
    it('returns a complete PaymentDeployedState when all outputs are present', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('MyManager'),
        PaymentMyManagerCoinbaseConnectorId: 'conn-coinbase-001',
      };

      const specs = [
        {
          name: 'MyManager',
          connectors: [
            {
              name: 'Coinbase',
              credentialProviderArn: COINBASE_CREDENTIAL_ARN,
              credentialProviderName: 'coinbase-cdp',
            },
          ],
        },
      ];

      const result = parsePaymentOutputs(outputs, specs);

      expect(result.MyManager).toBeDefined();
      expect(result.MyManager!.managerId).toBe('pm-mymanager-001');
      expect(result.MyManager!.managerArn).toBe('arn:aws:bedrock:us-east-1:123456789012:payment-manager/MyManager');
      expect(result.MyManager!.processPaymentRoleArn).toBe(
        'arn:aws:iam::123456789012:role/MyManagerProcessPaymentRole'
      );
      expect(result.MyManager!.resourceRetrievalRoleArn).toBe(
        'arn:aws:iam::123456789012:role/MyManagerResourceRetrievalRole'
      );
      expect(result.MyManager!.connectors.Coinbase).toEqual({
        connectorId: 'conn-coinbase-001',
        credentialProviderArn: COINBASE_CREDENTIAL_ARN,
        credentialProviderName: 'coinbase-cdp',
      });
    });
  });

  describe('missing required manager fields', () => {
    it('skips a payment when managerArn is absent', () => {
      const outputs: StackOutputs = {
        PaymentMyManagerManagerId: 'pm-001',
        PaymentMyManagerProcessPaymentRoleArn: 'arn:aws:iam::123:role/ProcessPaymentRole',
        PaymentMyManagerResourceRetrievalRoleArn: 'arn:aws:iam::123:role/ResourceRetrievalRole',
        // managerArn intentionally omitted
      };

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager).toBeUndefined();
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('skips a payment when managerId is absent', () => {
      const outputs: StackOutputs = {
        PaymentMyManagerManagerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/MyManager',
        PaymentMyManagerProcessPaymentRoleArn: 'arn:aws:iam::123:role/ProcessPaymentRole',
        PaymentMyManagerResourceRetrievalRoleArn: 'arn:aws:iam::123:role/ResourceRetrievalRole',
        // managerId intentionally omitted
      };

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager).toBeUndefined();
    });

    it('skips a payment when processPaymentRoleArn is absent', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('MyManager'),
      };
      delete outputs.PaymentMyManagerProcessPaymentRoleArn;

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager).toBeUndefined();
    });

    it('skips a payment when resourceRetrievalRoleArn is absent', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('MyManager'),
      };
      delete outputs.PaymentMyManagerResourceRetrievalRoleArn;

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager).toBeUndefined();
    });
  });

  describe('missing connector output', () => {
    it('includes the manager with an empty connectors map when connector output is absent', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');
      // No connector output key present

      const specs = [
        {
          name: 'MyManager',
          connectors: [
            {
              name: 'Coinbase',
              credentialProviderArn: COINBASE_CREDENTIAL_ARN,
            },
          ],
        },
      ];

      const result = parsePaymentOutputs(outputs, specs);

      expect(result.MyManager).toBeDefined();
      expect(result.MyManager!.connectors).toEqual({});
    });

    it('includes a manager that has no connectors configured at all', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager).toBeDefined();
      expect(result.MyManager!.connectors).toEqual({});
    });
  });

  describe('multiple managers', () => {
    it('parses both managers independently', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('Alpha'),
        ...makeOutputs('Beta'),
        PaymentAlphaCoinbaseConnectorId: 'conn-alpha-coinbase',
        PaymentBetaStripeConnectorId: 'conn-beta-stripe',
      };

      const specs = [
        {
          name: 'Alpha',
          connectors: [{ name: 'Coinbase', credentialProviderArn: 'arn:cred:alpha' }],
        },
        {
          name: 'Beta',
          connectors: [{ name: 'Stripe', credentialProviderArn: 'arn:cred:beta' }],
        },
      ];

      const result = parsePaymentOutputs(outputs, specs);

      expect(Object.keys(result)).toHaveLength(2);

      expect(result.Alpha!.managerId).toBe('pm-alpha-001');
      expect(result.Alpha!.connectors.Coinbase).toEqual({
        connectorId: 'conn-alpha-coinbase',
        credentialProviderArn: 'arn:cred:alpha',
        credentialProviderName: undefined,
      });

      expect(result.Beta!.managerId).toBe('pm-beta-001');
      expect(result.Beta!.connectors.Stripe).toEqual({
        connectorId: 'conn-beta-stripe',
        credentialProviderArn: 'arn:cred:beta',
        credentialProviderName: undefined,
      });
    });

    it('skips only the invalid manager when one of two is missing a required field', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('Good'),
        // Bad is missing resourceRetrievalRoleArn
        PaymentBadManagerArn: 'arn:aws:bedrock:us-east-1:123:payment-manager/Bad',
        PaymentBadManagerId: 'pm-bad-001',
        PaymentBadProcessPaymentRoleArn: 'arn:aws:iam::123:role/BadProcessPaymentRole',
      };

      const result = parsePaymentOutputs(outputs, [
        { name: 'Good', connectors: [] },
        { name: 'Bad', connectors: [] },
      ]);

      expect(result.Good).toBeDefined();
      expect(result.Bad).toBeUndefined();
    });
  });

  describe('authorizerType pass-through', () => {
    it('includes authorizerType AWS_IAM when set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', authorizerType: 'AWS_IAM', connectors: [] }]);

      expect(result.MyManager!.authorizerType).toBe('AWS_IAM');
    });

    it('includes authorizerType CUSTOM_JWT when set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [
        { name: 'MyManager', authorizerType: 'CUSTOM_JWT', connectors: [] },
      ]);

      expect(result.MyManager!.authorizerType).toBe('CUSTOM_JWT');
    });

    it('omits authorizerType when not set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager!.authorizerType).toBeUndefined();
    });
  });

  describe('autoPayment / toolAllowlist / networkPreferences pass-through', () => {
    it('includes autoPayment: true when set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', autoPayment: true, connectors: [] }]);

      expect(result.MyManager!.autoPayment).toBe(true);
    });

    it('includes autoPayment: false when explicitly set to false', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', autoPayment: false, connectors: [] }]);

      expect(result.MyManager!.autoPayment).toBe(false);
    });

    it('omits autoPayment when not set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager!.autoPayment).toBeUndefined();
    });

    it('includes paymentToolAllowlist when set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');
      const allowlist = ['x402_pay', 'x402_check_balance'];

      const result = parsePaymentOutputs(outputs, [
        { name: 'MyManager', paymentToolAllowlist: allowlist, connectors: [] },
      ]);

      expect(result.MyManager!.paymentToolAllowlist).toEqual(allowlist);
    });

    it('omits paymentToolAllowlist when not set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager!.paymentToolAllowlist).toBeUndefined();
    });

    it('includes networkPreferences when set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');
      const networks = ['eip155:84532', 'eip155:8453'];

      const result = parsePaymentOutputs(outputs, [
        { name: 'MyManager', networkPreferences: networks, connectors: [] },
      ]);

      expect(result.MyManager!.networkPreferences).toEqual(networks);
    });

    it('omits networkPreferences when not set in spec', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(result.MyManager!.networkPreferences).toBeUndefined();
    });

    it('passes all optional spec fields through together', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('MyManager'),
        PaymentMyManagerCoinbaseConnectorId: 'conn-001',
      };

      const result = parsePaymentOutputs(outputs, [
        {
          name: 'MyManager',
          authorizerType: 'AWS_IAM',
          autoPayment: true,
          paymentToolAllowlist: ['x402_pay'],
          networkPreferences: ['eip155:84532'],
          connectors: [{ name: 'Coinbase', credentialProviderArn: COINBASE_CREDENTIAL_ARN }],
        },
      ]);

      expect(result.MyManager!.authorizerType).toBe('AWS_IAM');
      expect(result.MyManager!.autoPayment).toBe(true);
      expect(result.MyManager!.paymentToolAllowlist).toEqual(['x402_pay']);
      expect(result.MyManager!.networkPreferences).toEqual(['eip155:84532']);
    });
  });

  describe('edge cases', () => {
    it('returns empty object when specs array is empty', () => {
      const outputs: StackOutputs = makeOutputs('MyManager');

      const result = parsePaymentOutputs(outputs, []);

      expect(result).toEqual({});
    });

    it('returns empty object when outputs is empty', () => {
      const result = parsePaymentOutputs({}, [{ name: 'MyManager', connectors: [] }]);

      expect(result).toEqual({});
    });

    it('ignores unrelated stack outputs', () => {
      const outputs: StackOutputs = {
        ...makeOutputs('MyManager'),
        SomeOtherOutputABC: 'unrelated-value',
        ApplicationAgentSomethingRuntimeIdOutput: 'rt-999',
      };

      const result = parsePaymentOutputs(outputs, [{ name: 'MyManager', connectors: [] }]);

      expect(Object.keys(result)).toHaveLength(1);
      expect(result.MyManager).toBeDefined();
    });
  });
});
