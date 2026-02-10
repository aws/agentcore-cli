import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddIdentityOptions,
  AddMcpToolOptions,
  AddMemoryOptions,
} from '../types.js';
import {
  validateAddAgentOptions,
  validateAddGatewayOptions,
  validateAddIdentityOptions,
  validateAddMcpToolOptions,
  validateAddMemoryOptions,
} from '../validate.js';
import { describe, expect, it } from 'vitest';

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
};

const validIdentityOptions: AddIdentityOptions = {
  name: 'test-identity',
  apiKey: 'test-key',
};

describe('validate', () => {
  describe('validateAddAgentOptions', () => {
    // AC1: All required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: { field: keyof AddAgentOptions; error: string }[] = [
        { field: 'name', error: '--name is required' },
        { field: 'framework', error: '--framework is required' },
        { field: 'modelProvider', error: '--model-provider is required' },
        { field: 'language', error: '--language is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validAgentOptionsByo, [field]: undefined };
        const result = validateAddAgentOptions(opts);
        expect(result.valid, `Should fail for missing ${String(field)}`).toBe(false);
        expect(result.error).toBe(error);
      }
    });

    // AC2: Invalid schema values rejected
    it('returns error for invalid schema values', () => {
      // Invalid name
      let result = validateAddAgentOptions({ ...validAgentOptionsByo, name: '123invalid' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('begin with') || result.error?.includes('letter')).toBeTruthy();

      // Invalid framework
      result = validateAddAgentOptions({ ...validAgentOptionsByo, framework: 'InvalidFW' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid framework')).toBeTruthy();

      // Invalid modelProvider
      result = validateAddAgentOptions({ ...validAgentOptionsByo, modelProvider: 'InvalidMP' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid model provider')).toBeTruthy();

      // Invalid language
      result = validateAddAgentOptions({ ...validAgentOptionsByo, language: 'InvalidLang' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid language')).toBeTruthy();
    });

    // AC3: Framework/model provider compatibility
    it('returns error for incompatible framework and model provider', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        framework: 'GoogleADK',
        modelProvider: 'Bedrock',
      });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('does not support')).toBeTruthy();
    });

    // AC4: BYO path requires codeLocation
    it('returns error for BYO path without codeLocation', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        type: 'byo',
        codeLocation: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--code-location is required for BYO path');
    });

    // AC5: Create path language restrictions
    it('returns error for create path with TypeScript or Other', () => {
      let result = validateAddAgentOptions({ ...validAgentOptionsCreate, language: 'TypeScript' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Python')).toBeTruthy();

      result = validateAddAgentOptions({ ...validAgentOptionsCreate, language: 'Other' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Python')).toBeTruthy();
    });

    // AC6: Create path requires memory
    it('returns error for create path without memory or invalid memory', () => {
      let result = validateAddAgentOptions({ ...validAgentOptionsCreate, memory: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--memory is required for create path');

      result = validateAddAgentOptions({ ...validAgentOptionsCreate, memory: 'invalid' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid memory option')).toBeTruthy();
    });

    // AC7: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddAgentOptions(validAgentOptionsByo)).toEqual({ valid: true });
      expect(validateAddAgentOptions(validAgentOptionsCreate)).toEqual({ valid: true });
    });
  });

  describe('validateAddGatewayOptions', () => {
    // AC8: Required fields validated
    it('returns error for missing name', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, name: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--name is required');
    });

    // AC9: Invalid name rejected
    it('returns error for invalid gateway name', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, name: 'INVALID_NAME!' });
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    // AC10: Invalid authorizerType rejected
    it('returns error for invalid authorizerType', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsNone, authorizerType: 'INVALID' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid authorizer type')).toBeTruthy();
    });

    // AC11: CUSTOM_JWT requires discoveryUrl and allowedClients (allowedAudience is optional)
    it('returns error for CUSTOM_JWT missing required fields', () => {
      const jwtFields: { field: keyof AddGatewayOptions; error: string }[] = [
        { field: 'discoveryUrl', error: '--discovery-url is required for CUSTOM_JWT authorizer' },
        { field: 'allowedClients', error: '--allowed-clients is required for CUSTOM_JWT authorizer' },
      ];

      for (const { field, error } of jwtFields) {
        const opts = { ...validGatewayOptionsJwt, [field]: undefined };
        const result = validateAddGatewayOptions(opts);
        expect(result.valid, `Should fail for missing ${String(field)}`).toBe(false);
        expect(result.error).toBe(error);
      }
    });

    // AC11b: allowedAudience is optional
    it('allows CUSTOM_JWT without allowedAudience', () => {
      const opts = { ...validGatewayOptionsJwt, allowedAudience: undefined };
      const result = validateAddGatewayOptions(opts);
      expect(result.valid).toBe(true);
    });

    // AC12: discoveryUrl validation
    it('returns error for invalid discoveryUrl', () => {
      // Invalid URL format
      let result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, discoveryUrl: 'not-a-url' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('valid URL')).toBeTruthy();

      // Missing well-known suffix
      result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, discoveryUrl: 'https://example.com/oauth' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('.well-known/openid-configuration')).toBeTruthy();
    });

    // AC13: Empty comma-separated clients rejected (audience can be empty)
    it('returns error for empty clients', () => {
      const result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, allowedClients: '  ,  ' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('At least one client value is required');
    });

    // AC14: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddGatewayOptions(validGatewayOptionsNone)).toEqual({ valid: true });
      expect(validateAddGatewayOptions(validGatewayOptionsJwt)).toEqual({ valid: true });
    });
  });

  describe('validateAddMcpToolOptions', () => {
    // AC15: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: { field: keyof AddMcpToolOptions; error: string }[] = [
        { field: 'name', error: '--name is required' },
        { field: 'language', error: '--language is required' },
        { field: 'exposure', error: '--exposure is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validMcpToolOptionsMcpRuntime, [field]: undefined };
        const result = validateAddMcpToolOptions(opts);
        expect(result.valid, `Should fail for missing ${String(field)}`).toBe(false);
        expect(result.error).toBe(error);
      }
    });

    // AC16: Invalid values rejected
    it('returns error for invalid values', () => {
      let result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, language: 'Java' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid language')).toBeTruthy();

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, exposure: 'invalid' as any });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid exposure')).toBeTruthy();
    });

    // AC17: mcp-runtime exposure requires agents
    it('returns error for mcp-runtime without agents', () => {
      let result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, agents: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--agents is required for mcp-runtime exposure');

      result = validateAddMcpToolOptions({ ...validMcpToolOptionsMcpRuntime, agents: ',,,' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('At least one agent is required');
    });

    // AC18: behind-gateway exposure is disabled (coming soon)
    it('returns coming soon error for behind-gateway exposure', () => {
      const result = validateAddMcpToolOptions({ ...validMcpToolOptionsBehindGateway });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('coming soon');
    });

    // AC19: Valid options pass
    it('passes for valid mcp-runtime options', () => {
      expect(validateAddMcpToolOptions(validMcpToolOptionsMcpRuntime)).toEqual({ valid: true });
    });
  });

  describe('validateAddMemoryOptions', () => {
    // AC20: Required fields validated
    it('returns error for missing name', () => {
      const result = validateAddMemoryOptions({ ...validMemoryOptions, name: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--name is required');
    });

    // AC21: Invalid strategies rejected, empty strategies allowed
    it('returns error for invalid strategies', () => {
      const result = validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'INVALID' });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid strategy')).toBeTruthy();
      expect(result.error?.includes('SEMANTIC')).toBeTruthy();
    });

    it('allows empty strategies', () => {
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: ',,,' })).toEqual({ valid: true });
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: undefined })).toEqual({ valid: true });
    });

    // AC22: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddMemoryOptions(validMemoryOptions)).toEqual({ valid: true });
      // Test all valid strategies
      expect(
        validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC,SUMMARIZATION,USER_PREFERENCE' })
      ).toEqual({ valid: true });
    });

    // AC23: CUSTOM strategy is not supported (Issue #235)
    it('rejects CUSTOM strategy', () => {
      const result = validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'CUSTOM' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid strategy: CUSTOM');
    });

    it('rejects CUSTOM even when mixed with valid strategies', () => {
      const result = validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC,CUSTOM' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid strategy: CUSTOM');
    });

    // AC24: Each individual valid strategy should pass
    it('accepts each valid strategy individually', () => {
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC' })).toEqual({ valid: true });
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SUMMARIZATION' })).toEqual({ valid: true });
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'USER_PREFERENCE' })).toEqual({
        valid: true,
      });
    });

    // AC25: Valid strategy combinations should pass
    it('accepts valid strategy combinations', () => {
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC,SUMMARIZATION' })).toEqual({
        valid: true,
      });
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SEMANTIC,USER_PREFERENCE' })).toEqual({
        valid: true,
      });
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: 'SUMMARIZATION,USER_PREFERENCE' })).toEqual({
        valid: true,
      });
    });

    // AC26: Strategies with whitespace should be handled
    it('handles strategies with whitespace', () => {
      expect(validateAddMemoryOptions({ ...validMemoryOptions, strategies: ' SEMANTIC , SUMMARIZATION ' })).toEqual({
        valid: true,
      });
    });
  });

  describe('validateAddIdentityOptions', () => {
    // AC23: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: { field: keyof AddIdentityOptions; error: string }[] = [
        { field: 'name', error: '--name is required' },
        { field: 'apiKey', error: '--api-key is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validIdentityOptions, [field]: undefined };
        const result = validateAddIdentityOptions(opts);
        expect(result.valid, `Should fail for missing ${String(field)}`).toBe(false);
        expect(result.error).toBe(error);
      }
    });

    // AC25: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddIdentityOptions(validIdentityOptions)).toEqual({ valid: true });
    });
  });
});
