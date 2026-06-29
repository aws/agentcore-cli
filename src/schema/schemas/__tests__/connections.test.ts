import { ConnectionSchema, ConnectionTargetSchema, GatewayOutboundAuthSchema } from '../connections';
import { describe, expect, it } from 'vitest';

const MEMORY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/abc123';
const GATEWAY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/gw-xyz';
const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/rt-xyz';
const PROVIDER_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/oauth2credentialprovider/partner';

describe('ConnectionSchema', () => {
  describe('memory target', () => {
    it('accepts a memory connection with namespaces and access', () => {
      const result = ConnectionSchema.safeParse({
        to: { type: 'memory', arn: MEMORY_ARN, namespaces: ['agent/*'] },
        access: 'readwrite',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a memory connection with just an arn', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'memory', arn: MEMORY_ARN } }).success).toBe(true);
    });

    it('rejects a malformed memory arn', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'memory', arn: 'not-an-arn' } }).success).toBe(false);
    });

    it('accepts a gov-cloud partition arn', () => {
      const arn = 'arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:111122223333:memory/abc123';
      expect(ConnectionSchema.safeParse({ to: { type: 'memory', arn } }).success).toBe(true);
    });
  });

  describe('gateway target', () => {
    it('accepts awsIam outbound auth', () => {
      expect(
        ConnectionSchema.safeParse({ to: { type: 'gateway', arn: GATEWAY_ARN, outboundAuth: { awsIam: {} } } }).success
      ).toBe(true);
    });

    it('accepts none outbound auth', () => {
      expect(
        ConnectionSchema.safeParse({ to: { type: 'gateway', arn: GATEWAY_ARN, outboundAuth: { none: {} } } }).success
      ).toBe(true);
    });

    it('accepts oauth outbound auth with all four fields', () => {
      const result = ConnectionSchema.safeParse({
        to: {
          type: 'gateway',
          arn: GATEWAY_ARN,
          outboundAuth: {
            oauth: {
              providerArn: PROVIDER_ARN,
              scopes: ['read'],
              grantType: 'CLIENT_CREDENTIALS',
              customParameters: { foo: 'bar' },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a gateway connection with no outboundAuth (defaults applied at wiring)', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'gateway', arn: GATEWAY_ARN } }).success).toBe(true);
    });

    it('rejects oauth without scopes', () => {
      const result = GatewayOutboundAuthSchema.safeParse({ oauth: { providerArn: PROVIDER_ARN } });
      expect(result.success).toBe(false);
    });

    it('rejects oauth without providerArn', () => {
      const result = GatewayOutboundAuthSchema.safeParse({ oauth: { scopes: ['read'] } });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown grantType', () => {
      const result = GatewayOutboundAuthSchema.safeParse({
        oauth: { providerArn: PROVIDER_ARN, scopes: ['read'], grantType: 'PASSWORD' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a malformed gateway arn', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'gateway', arn: 'not-an-arn' } }).success).toBe(false);
    });

    it('rejects a gateway arn pointing at the wrong resource type', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'gateway', arn: MEMORY_ARN } }).success).toBe(false);
    });
  });

  describe('runtime target', () => {
    it('accepts a runtime connection with exec', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'runtime', arn: RUNTIME_ARN, exec: true } }).success).toBe(true);
    });

    it('rejects a malformed runtime arn', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'runtime', arn: 'not-an-arn' } }).success).toBe(false);
    });
  });

  describe('browser / code-interpreter targets', () => {
    // Real customer-owned ARNs from CreateBrowser/CreateCodeInterpreter use the `-custom` segment.
    const BROWSER_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/browser_tool_3ok0y-ube4pqdHQ7';
    const CI_ARN =
      'arn:aws:bedrock-agentcore:us-east-1:111122223333:code-interpreter-custom/code_interpreter_9ejb4-dOCHBAd5OT';

    it('accepts a customer-owned browser ARN (browser-custom/ segment)', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'browser', arn: BROWSER_ARN } }).success).toBe(true);
    });

    it('accepts a browser connection with no ARN (AWS-managed default)', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'browser' } }).success).toBe(true);
    });

    it('accepts the AWS-managed default browser ARN (:aws: account, browser/ segment)', () => {
      const arn = 'arn:aws:bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1';
      expect(ConnectionSchema.safeParse({ to: { type: 'browser', arn } }).success).toBe(true);
    });

    it('accepts a customer-owned code-interpreter ARN (code-interpreter-custom/ segment)', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'codeInterpreter', arn: CI_ARN } }).success).toBe(true);
    });

    it('accepts a code-interpreter connection with no ARN', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'codeInterpreter' } }).success).toBe(true);
    });

    it('accepts the AWS-managed default code-interpreter ARN (:aws: account, code-interpreter/ segment)', () => {
      const arn = 'arn:aws:bedrock-agentcore:us-east-1:aws:code-interpreter/aws.codeinterpreter.v1';
      expect(ConnectionSchema.safeParse({ to: { type: 'codeInterpreter', arn } }).success).toBe(true);
    });

    it('rejects a malformed code-interpreter arn', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'codeInterpreter', arn: 'not-an-arn' } }).success).toBe(false);
    });

    it('rejects a browser ARN of the wrong resource type', () => {
      const arn = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/m-1';
      expect(ConnectionSchema.safeParse({ to: { type: 'browser', arn } }).success).toBe(false);
    });
  });

  describe('shape', () => {
    it('rejects an unknown target type', () => {
      expect(ConnectionTargetSchema.safeParse({ type: 's3', bucket: 'x' }).success).toBe(false);
    });

    it('rejects unknown top-level keys (strict)', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'memory', arn: MEMORY_ARN }, bogus: 1 }).success).toBe(false);
    });

    it('accepts an optional id and description', () => {
      const result = ConnectionSchema.safeParse({
        id: 'partner-memory',
        to: { type: 'memory', arn: MEMORY_ARN },
        description: 'reads partner memory',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an invalid id', () => {
      expect(ConnectionSchema.safeParse({ id: '1bad', to: { type: 'memory', arn: MEMORY_ARN } }).success).toBe(false);
    });

    it('rejects an id longer than 64 chars', () => {
      const id = 'a' + 'b'.repeat(64); // 65 chars
      expect(ConnectionSchema.safeParse({ id, to: { type: 'memory', arn: MEMORY_ARN } }).success).toBe(false);
    });

    it('accepts an id at the 64-char boundary', () => {
      const id = 'a' + 'b'.repeat(63); // 64 chars
      expect(ConnectionSchema.safeParse({ id, to: { type: 'memory', arn: MEMORY_ARN } }).success).toBe(true);
    });

    it('rejects an invalid access value', () => {
      expect(ConnectionSchema.safeParse({ to: { type: 'memory', arn: MEMORY_ARN }, access: 'admin' }).success).toBe(
        false
      );
    });

    it('rejects a description longer than 200 chars', () => {
      expect(
        ConnectionSchema.safeParse({ to: { type: 'memory', arn: MEMORY_ARN }, description: 'x'.repeat(201) }).success
      ).toBe(false);
    });
  });
});
