import { PaymentConnectorNameSchema, PaymentManagerNameSchema, PaymentManagerSchema } from '../primitives/payment';
import { describe, expect, it } from 'vitest';

describe('PaymentManagerNameSchema', () => {
  describe('length boundaries', () => {
    it('accepts exactly 48 characters', () => {
      const name = 'A' + 'b'.repeat(47);
      expect(name).toHaveLength(48);
      expect(PaymentManagerNameSchema.safeParse(name).success).toBe(true);
    });

    it('rejects 49 characters', () => {
      const name = 'A' + 'b'.repeat(48);
      expect(name).toHaveLength(49);
      expect(PaymentManagerNameSchema.safeParse(name).success).toBe(false);
    });

    it('rejects empty string', () => {
      expect(PaymentManagerNameSchema.safeParse('').success).toBe(false);
    });

    it('accepts single letter', () => {
      expect(PaymentManagerNameSchema.safeParse('A').success).toBe(true);
    });
  });

  describe('format validation', () => {
    it('rejects name starting with a digit', () => {
      expect(PaymentManagerNameSchema.safeParse('1manager').success).toBe(false);
    });

    it('rejects name starting with an underscore', () => {
      expect(PaymentManagerNameSchema.safeParse('_manager').success).toBe(false);
    });

    it('rejects underscores (CreatePaymentManager API disallows them)', () => {
      // Unlike connectors, the CreatePaymentManager API pattern is
      // [a-zA-Z][a-zA-Z0-9]{0,47} — no underscores. Reject at parse time so the
      // user sees the error at `add` instead of a late CFN failure.
      expect(PaymentManagerNameSchema.safeParse('my_manager').success).toBe(false);
    });

    it('rejects hyphens', () => {
      expect(PaymentManagerNameSchema.safeParse('my-manager').success).toBe(false);
    });

    it('rejects spaces', () => {
      expect(PaymentManagerNameSchema.safeParse('my manager').success).toBe(false);
    });

    it('rejects special characters', () => {
      expect(PaymentManagerNameSchema.safeParse('mgr@1').success).toBe(false);
      expect(PaymentManagerNameSchema.safeParse('mgr.one').success).toBe(false);
    });
  });
});

describe('PaymentConnectorNameSchema', () => {
  it('accepts exactly 48 characters', () => {
    const name = 'C' + 'o'.repeat(47);
    expect(PaymentConnectorNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects 49 characters', () => {
    const name = 'C' + 'o'.repeat(48);
    expect(PaymentConnectorNameSchema.safeParse(name).success).toBe(false);
  });

  it('rejects hyphens', () => {
    expect(PaymentConnectorNameSchema.safeParse('my-connector').success).toBe(false);
  });

  it('rejects name starting with digit', () => {
    expect(PaymentConnectorNameSchema.safeParse('9connector').success).toBe(false);
  });
});

describe('PaymentManagerSchema', () => {
  const validBase = { name: 'testManager', connectors: [] };

  describe('CUSTOM_JWT requires authorizerConfiguration', () => {
    it('fails when authorizerConfiguration is missing', () => {
      const result = PaymentManagerSchema.safeParse({ ...validBase, authorizerType: 'CUSTOM_JWT' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.includes('authorizerConfiguration'))).toBe(true);
      }
    });

    it('passes with valid customJWTAuthorizer', () => {
      const result = PaymentManagerSchema.safeParse({
        ...validBase,
        authorizerType: 'CUSTOM_JWT',
        authorizerConfiguration: {
          customJWTAuthorizer: { discoveryUrl: 'https://example.com/.well-known/openid-configuration' },
        },
      });
      expect(result.success).toBe(true);
    });

    it('passes with AWS_IAM and no authorizerConfiguration', () => {
      const result = PaymentManagerSchema.safeParse({ ...validBase, authorizerType: 'AWS_IAM' });
      expect(result.success).toBe(true);
    });
  });

  describe('autoPayment / defaultSpendLimit defaults', () => {
    it('materializes documented defaults when omitted', () => {
      const result = PaymentManagerSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoPayment).toBe(true);
        expect(result.data.defaultSpendLimit).toBe('10.00');
      }
    });

    it('accepts explicit false', () => {
      const result = PaymentManagerSchema.safeParse({ ...validBase, autoPayment: false });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.autoPayment).toBe(false);
    });
  });
});
