import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddGatewayTargetOptions,
  AddIdentityOptions,
  AddMemoryOptions,
} from '../types.js';
import {
  validateAddAgentOptions,
  validateAddGatewayOptions,
  validateAddGatewayTargetOptions,
  validateAddIdentityOptions,
  validateAddMemoryOptions,
} from '../validate.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockGetExistingGateways = vi.fn();

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
  },
}));

vi.mock('../../../operations/mcp/create-mcp.js', () => ({
  getExistingGateways: (...args: unknown[]) => mockGetExistingGateways(...args),
}));

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

const validGatewayTargetOptions: AddGatewayTargetOptions = {
  name: 'test-tool',
  language: 'Python',
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
  afterEach(() => vi.clearAllMocks());

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

    // AC15: agentClientId and agentClientSecret must be provided together
    it('returns error when agentClientId provided without agentClientSecret', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        agentClientId: 'my-client-id',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Both --agent-client-id and --agent-client-secret must be provided together');
    });

    it('returns error when agentClientSecret provided without agentClientId', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        agentClientSecret: 'my-secret',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Both --agent-client-id and --agent-client-secret must be provided together');
    });

    // AC16: agent credentials only valid with CUSTOM_JWT
    it('returns error when agent credentials used with non-CUSTOM_JWT authorizer', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsNone,
        agentClientId: 'my-client-id',
        agentClientSecret: 'my-secret',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Agent OAuth credentials are only valid with CUSTOM_JWT authorizer');
    });

    // AC17: valid CUSTOM_JWT with agent credentials passes
    it('passes for CUSTOM_JWT with agent credentials', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        agentClientId: 'my-client-id',
        agentClientSecret: 'my-secret',
        allowedScopes: 'scope1,scope2',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAddGatewayTargetOptions', () => {
    beforeEach(() => {
      // By default, mock that the gateway from validGatewayTargetOptions exists
      mockGetExistingGateways.mockResolvedValue(['my-gateway']);
    });

    // AC15: Required fields validated
    it('returns error for missing name', async () => {
      const opts = { ...validGatewayTargetOptions, name: undefined };
      const result = await validateAddGatewayTargetOptions(opts);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--name is required');
    });

    it('returns error for missing language (non-existing-endpoint)', async () => {
      const opts = { ...validGatewayTargetOptions, language: undefined };
      const result = await validateAddGatewayTargetOptions(opts);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--language is required');
    });

    // Gateway is required
    it('returns error when --gateway is missing', async () => {
      const opts = { ...validGatewayTargetOptions, gateway: undefined };
      const result = await validateAddGatewayTargetOptions(opts);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--gateway is required');
    });

    it('returns error when no gateways exist', async () => {
      mockGetExistingGateways.mockResolvedValue([]);
      const result = await validateAddGatewayTargetOptions(validGatewayTargetOptions);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No gateways found');
      expect(result.error).toContain('agentcore add gateway');
    });

    it('returns error when specified gateway does not exist', async () => {
      mockGetExistingGateways.mockResolvedValue(['other-gateway']);
      const result = await validateAddGatewayTargetOptions(validGatewayTargetOptions);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Gateway "my-gateway" not found');
      expect(result.error).toContain('other-gateway');
    });

    // AC16: Invalid values rejected
    it('returns error for invalid values', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        language: 'Java' as any,
      });
      expect(result.valid).toBe(false);
      expect(result.error?.includes('Invalid language')).toBeTruthy();
    });

    // AC18: Valid options pass
    it('passes for valid gateway target options', async () => {
      const result = await validateAddGatewayTargetOptions({ ...validGatewayTargetOptions });
      expect(result.valid).toBe(true);
    });
    // AC20: existing-endpoint source validation
    it('passes for valid existing-endpoint with https', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        endpoint: 'https://example.com/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
      expect(options.language).toBe('Other');
    });

    it('passes for valid existing-endpoint with http', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        endpoint: 'http://localhost:3000/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
    });

    it('returns error for existing-endpoint without endpoint', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--endpoint is required when source is existing-endpoint');
    });

    it('returns error for existing-endpoint with non-http(s) URL', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        endpoint: 'ftp://example.com/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Endpoint must use http:// or https:// protocol');
    });

    it('returns error for existing-endpoint with invalid URL', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        endpoint: 'not-a-url',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Endpoint must be a valid URL (e.g. https://example.com/mcp)');
    });

    // AC21: credential validation through outbound auth
    it('returns error when credential not found', async () => {
      mockReadProjectSpec.mockResolvedValue({
        credentials: [{ name: 'existing-cred', type: 'ApiKey' }],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        language: 'Python',
        gateway: 'my-gateway',
        outboundAuthType: 'API_KEY',
        credentialName: 'missing-cred',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Credential "missing-cred" not found');
    });

    it('returns error when no credentials configured', async () => {
      mockReadProjectSpec.mockResolvedValue({
        credentials: [],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        language: 'Python',
        gateway: 'my-gateway',
        outboundAuthType: 'API_KEY',
        credentialName: 'any-cred',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No credentials are configured');
    });

    it('passes when credential exists', async () => {
      mockReadProjectSpec.mockResolvedValue({
        credentials: [{ name: 'valid-cred', type: 'ApiKey' }],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        language: 'Python',
        gateway: 'my-gateway',
        outboundAuthType: 'API_KEY',
        credentialName: 'valid-cred',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
    });

    // Outbound auth inline OAuth validation
    it('passes for OAUTH with inline OAuth fields', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'OAUTH',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        oauthDiscoveryUrl: 'https://auth.example.com',
      });
      expect(result.valid).toBe(true);
    });

    it('returns error for OAUTH without credential-name or inline fields', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'OAUTH',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--credential-name or inline OAuth fields');
    });

    it('returns error for incomplete inline OAuth (missing client-secret)', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'OAUTH',
        oauthClientId: 'cid',
        oauthDiscoveryUrl: 'https://auth.example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--oauth-client-secret');
    });

    it('returns error for API_KEY with inline OAuth fields', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'API_KEY',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        oauthDiscoveryUrl: 'https://auth.example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be used with API_KEY');
    });

    it('returns error for API_KEY without credential-name', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'API_KEY',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--credential-name is required');
    });

    it('rejects --host with existing-endpoint', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        source: 'existing-endpoint',
        endpoint: 'https://example.com/mcp',
        host: 'Lambda',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--host is not applicable for existing endpoint targets');
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

  describe('validateAddIdentityOptions OAuth', () => {
    it('passes for valid OAuth identity', () => {
      const result = validateAddIdentityOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
        clientId: 'client123',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(true);
    });

    it('returns error for OAuth without discovery-url', () => {
      const result = validateAddIdentityOptions({
        name: 'my-oauth',
        type: 'oauth',
        clientId: 'client123',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--discovery-url');
    });

    it('returns error for OAuth without client-id', () => {
      const result = validateAddIdentityOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--client-id');
    });

    it('returns error for OAuth without client-secret', () => {
      const result = validateAddIdentityOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com',
        clientId: 'client123',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--client-secret');
    });

    it('still requires api-key for default type', () => {
      const result = validateAddIdentityOptions({ name: 'my-key' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--api-key');
    });
  });
});
