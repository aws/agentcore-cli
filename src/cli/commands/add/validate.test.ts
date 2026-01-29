import { describe, it } from 'bun:test';
import assert from 'node:assert';
import {
  validateAddAgentOptions,
  validateAddGatewayOptions,
  validateAddMcpToolOptions,
  validateAddMemoryOptions,
  validateAddIdentityOptions,
} from './validate.js';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddMcpToolOptions,
  AddMemoryOptions,
  AddIdentityOptions,
} from './types.js';

// Helper: valid base options for each type
const validAgentOptionsByo: AddAgentOptions = {
  name: 'TestAgent',
  type: 'byo',
  language: 'Python',
  framework: 'Strands',
  modelProvider: 'Bedrock',
  codeLocation: '/path/to/code',
};

const validAgentOptionsCreate: AddAgentOptions = {
  name: 'TestAgent',
  type: 'create',
  language: 'Python',
  framework: 'Strands',
  modelProvider: 'Bedrock',
  memory: 'none',
};

const validGatewayOptionsNone: AddGatewayOptions = {
  name: 'test-gateway',
  authorizerType: 'NONE',
};

const validGatewayOptionsJwt: AddGatewayOptions = {
  name: 'test-gateway',
  authorizerType: 'CUSTOM_JWT',
  discoveryUrl: 'https://example.com/.well-known/openid-configuration',
  allowedAudience: 'aud1,aud2',
  allowedClients: 'client1,client2',
};

const validMcpToolOptionsMcpRuntime: AddMcpToolOptions = {
  name: 'test-tool',
  language: 'Python',
  exposure: 'mcp-runtime',
  agents: 'Agent1,Agent2',
};

const validMcpToolOptionsBehindGateway: AddMcpToolOptions = {
  name: 'test-tool',
  language: 'Python',
  exposure: 'behind-gateway',
  gateway: 'my-gateway',
  host: 'Lambda',
};

const validMemoryOptions: AddMemoryOptions = {
  name: 'test-memory',
  strategies: 'SEMANTIC,SUMMARIZATION',
  owner: 'TestAgent',
};

const validIdentityOptions: AddIdentityOptions = {
  name: 'test-identity',
  type: 'ApiKeyCredentialProvider',
  apiKey: 'test-key',
  owner: 'TestAgent',
};

describe('validate', () => {
  describe('validateAddAgentOptions', () => {
    // AC1: All required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: Array<{ field: keyof AddAgentOptions; error: string }> = [
        { field: 'name', error: '--name is required' },
        { field: 'framework', error: '--framework is required' },
        { field: 'modelProvider', error: '--model-provider is required' },
        { field: 'language', error: '--language is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validAgentOptionsByo, [field]: undefined };
        const result = validateAddAgentOptions(opts);
        assert.strictEqual(result.valid, false, `Should fail for missing ${field}`);
        assert.strictEqual(result.error, error);
      }
    });

    // AC2: Invalid schema values rejected
    it('returns error for invalid schema values', () => {
      // Invalid name
      let result = validateAddAgentOptions({ ...validAgentOptionsByo, name: '123invalid' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('begin with') || result.error?.includes('letter'));

      // Invalid framework
      result = validateAddAgentOptions({ ...validAgentOptionsByo, framework: 'InvalidFW' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid framework'));

      // Invalid modelProvider
      result = validateAddAgentOptions({ ...validAgentOptionsByo, modelProvider: 'InvalidMP' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid model provider'));

      // Invalid language
      result = validateAddAgentOptions({ ...validAgentOptionsByo, language: 'InvalidLang' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid language'));
    });

    // AC3: Framework/model provider compatibility
    it('returns error for incompatible framework and model provider', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        framework: 'GoogleADK',
        modelProvider: 'Bedrock',
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('does not support'));
    });

    // AC4: BYO path requires codeLocation
    it('returns error for BYO path without codeLocation', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        type: 'byo',
        codeLocation: undefined,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--code-location is required for BYO path');
    });

    // AC5: Create path language restrictions
    it('returns error for create path with TypeScript or Other', () => {
      let result = validateAddAgentOptions({ ...validAgentOptionsCreate, language: 'TypeScript' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Python'));

      result = validateAddAgentOptions({ ...validAgentOptionsCreate, language: 'Other' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Python'));
    });

    // AC6: Create path requires memory
    it('returns error for create path without memory or invalid memory', () => {
      let result = validateAddAgentOptions({ ...validAgentOptionsCreate, memory: undefined });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--memory is required for create path');

      result = validateAddAgentOptions({ ...validAgentOptionsCreate, memory: 'invalid' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid memory option'));
    });

    // AC7: Valid options pass
    it('passes for valid options', () => {
      assert.deepStrictEqual(validateAddAgentOptions(validAgentOptionsByo), { valid: true });
      assert.deepStrictEqual(validateAddAgentOptions(validAgentOptionsCreate), { valid: true });
    });
  });

  describe('validateAddGatewayOptions', () => {
    // AC8: Required fields validated
    it('returns error for missing name', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, name: undefined });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--name is required');
    });

    // AC9: Invalid name rejected
    it('returns error for invalid gateway name', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, name: 'INVALID_NAME!' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
    });

    // AC10: Invalid authorizerType rejected
    it('returns error for invalid authorizerType', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, authorizerType: 'INVALID' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid authorizer type'));
    });

    // AC11: CUSTOM_JWT requires all fields
    it('returns error for CUSTOM_JWT missing required fields', () => {
      const jwtFields: Array<{ field: keyof AddGatewayOptions; error: string }> = [
        { field: 'discoveryUrl', error: '--discovery-url is required for CUSTOM_JWT authorizer' },
        { field: 'allowedAudience', error: '--allowed-audience is required for CUSTOM_JWT authorizer' },
        { field: 'allowedClients', error: '--allowed-clients is required for CUSTOM_JWT authorizer' },
      ];

      for (const { field, error } of jwtFields) {
        const opts = { ...validGatewayOptionsJwt, [field]: undefined };
        const result = validateAddGatewayOptions(opts);
        assert.strictEqual(result.valid, false, `Should fail for missing ${field}`);
        assert.strictEqual(result.error, error);
      }
    });

    // AC12: discoveryUrl validation
    it('returns error for invalid discoveryUrl', () => {
      // Invalid URL format
      let result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, discoveryUrl: 'not-a-url' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('valid URL'));

      // Missing well-known suffix
      result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, discoveryUrl: 'https://example.com/oauth' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('.well-known/openid-configuration'));
    });

    // AC13: Empty comma-separated values rejected
    it('returns error for empty audience or clients', () => {
      let result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, allowedAudience: ',,,' });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'At least one audience value is required');

      result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, allowedClients: '  ,  ' });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'At least one client value is required');
    });

    // AC14: Valid options pass
    it('passes for valid options', () => {
      assert.deepStrictEqual(validateAddGatewayOptions(validGatewayOptionsNone), { valid: true });
      assert.deepStrictEqual(validateAddGatewayOptions(validGatewayOptionsJwt), { valid: true });
    });
  });

  describe('validateAddMcpToolOptions', () => {
    // AC15: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: Array<{ field: keyof AddMcpToolOptions; error: string }> = [
        { field: 'name', error: '--name is required' },
        { field: 'language', error: '--language is required' },
        { field: 'exposure', error: '--exposure is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validMcpToolOptionsMcpRuntime, [field]: undefined };
        const result = validateAddMcpToolOptions(opts);
        assert.strictEqual(result.valid, false, `Should fail for missing ${field}`);
        assert.strictEqual(result.error, error);
      }
    });

    // AC16: Invalid values rejected
    it('returns error for invalid values', () => {
      let result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, language: 'Java' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid language'));

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, exposure: 'invalid' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid exposure'));
    });

    // AC17: mcp-runtime exposure requires agents
    it('returns error for mcp-runtime without agents', () => {
      let result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, agents: undefined });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--agents is required for mcp-runtime exposure');

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, agents: ',,,' });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'At least one agent is required');
    });

    // AC18: behind-gateway exposure requires gateway and host
    it('returns error for behind-gateway missing gateway, host, or invalid host', () => {
      let result = validateAddMcpToolOptions({ ...validMcpToolOptionsBehindGateway, gateway: undefined });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--gateway is required for behind-gateway exposure');

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsBehindGateway, host: undefined });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, '--host is required for behind-gateway exposure');

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsBehindGateway, host: 'InvalidHost' as any });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid host'));
    });

    // AC19: Valid options pass
    it('passes for valid options', () => {
      assert.deepStrictEqual(validateAddMcpToolOptions(validMcpToolOptionsMcpRuntime), { valid: true });
      assert.deepStrictEqual(validateAddMcpToolOptions(validMcpToolOptionsBehindGateway), { valid: true });
    });
  });

  describe('validateAddMemoryOptions', () => {
    // AC20: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: Array<{ field: keyof AddMemoryOptions; error: string }> = [
        { field: 'name', error: '--name is required' },
        { field: 'strategies', error: '--strategies is required' },
        { field: 'owner', error: '--owner is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validMemoryOptions, [field]: undefined };
        const result = validateAddMemoryOptions(opts);
        assert.strictEqual(result.valid, false, `Should fail for missing ${field}`);
        assert.strictEqual(result.error, error);
      }
    });

    // AC21: Invalid/empty strategies rejected
    it('returns error for invalid or empty strategies', () => {
      let result = validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'INVALID' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid strategy'));
      assert.ok(result.error?.includes('SEMANTIC'));

      result = validateAddMemoryOptions({ ...validMemoryOptions, strategies: ',,,' });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'At least one strategy is required');
    });

    // AC22: Valid options pass
    it('passes for valid options', () => {
      assert.deepStrictEqual(validateAddMemoryOptions(validMemoryOptions), { valid: true });
      // Test all valid strategies
      assert.deepStrictEqual(
        validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC,SUMMARIZATION,USER_PREFERENCE,CUSTOM' }),
        { valid: true }
      );
    });
  });

  describe('validateAddIdentityOptions', () => {
    // AC23: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: Array<{ field: keyof AddIdentityOptions; error: string }> = [
        { field: 'name', error: '--name is required' },
        { field: 'type', error: '--type is required' },
        { field: 'apiKey', error: '--api-key is required' },
        { field: 'owner', error: '--owner is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validIdentityOptions, [field]: undefined };
        const result = validateAddIdentityOptions(opts);
        assert.strictEqual(result.valid, false, `Should fail for missing ${field}`);
        assert.strictEqual(result.error, error);
      }
    });

    // AC24: Only ApiKeyCredentialProvider supported
    it('returns error for unsupported type', () => {
      const result = validateAddIdentityOptions({ ...validIdentityOptions, type: 'OtherType' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Only ApiKeyCredentialProvider is supported'));
    });

    // AC25: Valid options pass
    it('passes for valid options', () => {
      assert.deepStrictEqual(validateAddIdentityOptions(validIdentityOptions), { valid: true });
    });
  });
});
