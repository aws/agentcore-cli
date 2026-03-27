import type {
  AddAgentOptions,
  AddCredentialOptions,
  AddGatewayOptions,
  AddGatewayTargetOptions,
  AddMemoryOptions,
} from '../types.js';
import {
  validateAddAgentOptions,
  validateAddCredentialOptions,
  validateAddGatewayOptions,
  validateAddGatewayTargetOptions,
  validateAddMemoryOptions,
} from '../validate.js';
import { existsSync, readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockConfigExists = vi.fn().mockReturnValue(true);

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    configExists = mockConfigExists;
  },
  findConfigRoot: vi.fn().mockReturnValue('/mock/project/agentcore'),
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn().mockReturnValue('[]') };
});

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
  type: 'mcp-server',
  endpoint: 'https://example.com/mcp',
  gateway: 'my-gateway',
};

const validMemoryOptions: AddMemoryOptions = {
  name: 'test-memory',
  strategies: 'SEMANTIC,SUMMARIZATION',
};

const validCredentialOptions: AddCredentialOptions = {
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

    // Case-insensitive flag values
    it('accepts lowercase flag values and normalizes them', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        framework: 'strands' as any,
        modelProvider: 'bedrock' as any,
        language: 'python' as any,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts uppercase flag values and normalizes them', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        framework: 'STRANDS' as any,
        modelProvider: 'BEDROCK' as any,
        language: 'PYTHON' as any,
      });
      expect(result.valid).toBe(true);
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

    // AC11: CUSTOM_JWT requires discoveryUrl; at least one of allowedAudience/allowedClients/allowedScopes
    it('returns error for CUSTOM_JWT missing required fields', () => {
      // discoveryUrl is always required
      const result = validateAddGatewayOptions({ ...validGatewayOptionsJwt, discoveryUrl: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--discovery-url is required for CUSTOM_JWT authorizer');

      // All three optional fields absent fails
      const noneResult = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        allowedAudience: undefined,
        allowedClients: undefined,
        allowedScopes: undefined,
      });
      expect(noneResult.valid).toBe(false);
      expect(noneResult.error).toBe(
        'At least one of --allowed-audience, --allowed-clients, --allowed-scopes, or --custom-claims must be provided for CUSTOM_JWT authorizer'
      );
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

    // AC13: At least one of audience/clients/scopes must be non-empty
    it('returns error when all of audience, clients, and scopes are empty', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        allowedAudience: '  ',
        allowedClients: undefined,
        allowedScopes: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'At least one of --allowed-audience, --allowed-clients, --allowed-scopes, or --custom-claims must be provided for CUSTOM_JWT authorizer'
      );
    });

    // AC-claims1: --custom-claims with valid JSON passes validation
    it('accepts valid --custom-claims JSON', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        customClaims: JSON.stringify([
          {
            inboundTokenClaimName: 'dept',
            inboundTokenClaimValueType: 'STRING',
            authorizingClaimMatchValue: {
              claimMatchOperator: 'EQUALS',
              claimMatchValue: { matchValueString: 'engineering' },
            },
          },
        ]),
      });
      expect(result.valid).toBe(true);
    });

    // AC-claims2: --custom-claims alone satisfies the "at least one constraint" check
    it('allows CUSTOM_JWT with only --custom-claims (no audience/clients/scopes)', () => {
      const result = validateAddGatewayOptions({
        name: 'test-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        customClaims: JSON.stringify([
          {
            inboundTokenClaimName: 'role',
            inboundTokenClaimValueType: 'STRING_ARRAY',
            authorizingClaimMatchValue: {
              claimMatchOperator: 'CONTAINS_ANY',
              claimMatchValue: { matchValueStringList: ['admin'] },
            },
          },
        ]),
      });
      expect(result.valid).toBe(true);
    });

    // AC-claims3: --custom-claims with invalid JSON fails
    it('returns error for --custom-claims with invalid JSON', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        customClaims: 'not json',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--custom-claims must be valid JSON');
    });

    // AC-claims4: --custom-claims with empty array fails
    it('returns error for --custom-claims with empty array', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        customClaims: '[]',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--custom-claims must be a non-empty JSON array');
    });

    // AC-claims5: --custom-claims with invalid claim structure fails
    it('returns error for --custom-claims with invalid claim structure', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        customClaims: JSON.stringify([{ badField: 'value' }]),
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid custom claim at index 0');
    });

    // AC14: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddGatewayOptions(validGatewayOptionsNone)).toEqual({ valid: true });
      expect(validateAddGatewayOptions(validGatewayOptionsJwt)).toEqual({ valid: true });
    });

    // AC15: clientId and clientSecret must be provided together
    it('returns error when clientId provided without clientSecret', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        clientId: 'my-client-id',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Both --client-id and --client-secret must be provided together');
    });

    it('returns error when clientSecret provided without clientId', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        clientSecret: 'my-secret',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Both --client-id and --client-secret must be provided together');
    });

    // AC16: OAuth client credentials only valid with CUSTOM_JWT
    it('returns error when OAuth client credentials used with non-CUSTOM_JWT authorizer', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsNone,
        clientId: 'my-client-id',
        clientSecret: 'my-secret',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('OAuth client credentials are only valid with CUSTOM_JWT authorizer');
    });

    // AC17: valid CUSTOM_JWT with OAuth client credentials passes
    it('passes for CUSTOM_JWT with OAuth client credentials', () => {
      const result = validateAddGatewayOptions({
        ...validGatewayOptionsJwt,
        clientId: 'my-client-id',
        clientSecret: 'my-secret',
        allowedScopes: 'scope1,scope2',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAddGatewayTargetOptions', () => {
    beforeEach(() => {
      // By default, mock that the gateway from validGatewayTargetOptions exists
      mockReadProjectSpec.mockResolvedValue({ agentCoreGateways: [{ name: 'my-gateway' }] });
    });

    // AC15: Required fields validated
    it('returns error for missing name', async () => {
      const opts = { ...validGatewayTargetOptions, name: undefined };
      const result = await validateAddGatewayTargetOptions(opts);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--name is required');
    });

    it('returns error when --gateway is missing', async () => {
      const opts = { ...validGatewayTargetOptions, gateway: undefined };
      const result = await validateAddGatewayTargetOptions(opts);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--gateway is required');
    });

    it('returns error when no gateways exist', async () => {
      mockReadProjectSpec.mockResolvedValue({ agentCoreGateways: [] });
      const result = await validateAddGatewayTargetOptions({ ...validGatewayTargetOptions });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No gateways found');
      expect(result.error).toContain('agentcore add gateway');
    });

    it('returns error when specified gateway does not exist', async () => {
      mockReadProjectSpec.mockResolvedValue({ agentCoreGateways: [{ name: 'other-gateway' }] });
      const result = await validateAddGatewayTargetOptions({ ...validGatewayTargetOptions });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Gateway "my-gateway" not found');
      expect(result.error).toContain('other-gateway');
    });

    // AC18: Valid options pass
    it('passes for valid gateway target options', async () => {
      const result = await validateAddGatewayTargetOptions({ ...validGatewayTargetOptions });
      expect(result.valid).toBe(true);
    });
    // AC20: type validation
    it('returns error when --type is missing', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--type is required');
    });

    it('accepts --type mcp-server', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
      expect(options.language).toBe('Other');
    });

    it('returns error for invalid --type', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'invalid',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid type');
    });

    it('passes for mcp-server with https endpoint', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
    });

    it('passes for mcp-server with http endpoint', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'http://localhost:3000/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(true);
    });

    it('returns error for mcp-server without endpoint', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--endpoint is required');
    });

    it('returns error for mcp-server with non-http(s) URL', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'ftp://example.com/mcp',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Endpoint must use http:// or https:// protocol');
    });

    it('returns error for mcp-server with invalid URL', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
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
        agentCoreGateways: [{ name: 'my-gateway' }],
        credentials: [{ name: 'existing-cred', type: 'ApiKey' }],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
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
        agentCoreGateways: [{ name: 'my-gateway' }],
        credentials: [],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
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
        agentCoreGateways: [{ name: 'my-gateway' }],
        credentials: [{ name: 'valid-cred', type: 'ApiKey' }],
      });

      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
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

    it('returns error for invalid OAuth discovery URL', async () => {
      const result = await validateAddGatewayTargetOptions({
        ...validGatewayTargetOptions,
        outboundAuthType: 'OAUTH',
        oauthClientId: 'cid',
        oauthClientSecret: 'csec',
        oauthDiscoveryUrl: 'not-a-url',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--oauth-discovery-url must be a valid URL');
    });

    it('accepts valid api-gateway options', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects api-gateway without --rest-api-id', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        stage: 'prod',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--rest-api-id is required');
    });

    it('rejects api-gateway without --stage', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--stage is required');
    });

    it('rejects --endpoint for api-gateway type', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
        endpoint: 'https://example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable');
    });

    it('rejects --host for api-gateway type', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
        host: 'Lambda',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable');
    });

    it('rejects --outbound-auth oauth for api-gateway type', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
        outboundAuthType: 'OAUTH',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('is not supported for api-gateway type');
    });

    it('accepts --outbound-auth api-key with --credential-name for api-gateway type', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
        outboundAuthType: 'API_KEY',
        credentialName: 'my-key',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects --outbound-auth api-key without --credential-name for api-gateway type', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-api',
        type: 'api-gateway',
        restApiId: 'abc123',
        stage: 'prod',
        gateway: 'my-gateway',
        outboundAuthType: 'API_KEY',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--credential-name is required');
    });

    // Lambda Function ARN target validation
    it('accepts valid lambda-function-arn options', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[{"name":"tool1","description":"desc"}]');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects lambda-function-arn without --lambda-arn', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--lambda-arn is required');
    });

    it('rejects lambda-function-arn without --tool-schema-file', async () => {
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--tool-schema-file is required');
    });

    it('accepts lambda-function-arn with absolute path', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify([{ name: 'tool1', description: 'desc' }]));
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: '/absolute/path/tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(true);
      // Verify the absolute path was used as-is, not joined with project root
      expect(vi.mocked(existsSync)).toHaveBeenCalledWith('/absolute/path/tools.json');
      expect(vi.mocked(readFileSync)).toHaveBeenCalledWith('/absolute/path/tools.json', 'utf-8');
    });

    it('accepts lambda-function-arn with relative path resolved from project root', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify([{ name: 'tool1', description: 'desc' }]));
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(true);
      // Verify relative path was resolved from project root (dirname of configRoot)
      const calledPath = vi.mocked(existsSync).mock.calls.find(c => String(c[0]).includes('tools.json'));
      expect(calledPath).toBeDefined();
      expect(String(calledPath![0])).not.toBe('./tools.json'); // Should be resolved, not raw
    });

    it('rejects lambda-function-arn when file not found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects lambda-function-arn with invalid JSON', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('not json');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not valid JSON');
    });

    it('rejects lambda-function-arn with non-array JSON', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{}');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON array');
    });

    it('rejects lambda-function-arn with empty array', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[]');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least one tool definition');
    });

    it('rejects lambda-function-arn with missing name in element', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[{"description":"d"}]');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing a valid "name"');
    });

    it('rejects --endpoint for lambda-function-arn type', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[{"name":"tool1","description":"desc"}]');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
        endpoint: 'https://example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable');
    });

    it('rejects --outbound-auth for lambda-function-arn type', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('[{"name":"tool1","description":"desc"}]');
      const result = await validateAddGatewayTargetOptions({
        name: 'my-lambda',
        type: 'lambda-function-arn',
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-func',
        toolSchemaFile: './tools.json',
        gateway: 'my-gateway',
        outboundAuthType: 'NONE',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable');
    });

    it('rejects --host with mcp-server type', async () => {
      const options: AddGatewayTargetOptions = {
        name: 'test-tool',
        type: 'mcp-server',
        endpoint: 'https://example.com/mcp',
        host: 'Lambda',
        gateway: 'my-gateway',
      };
      const result = await validateAddGatewayTargetOptions(options);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('--host is not applicable for MCP server targets');
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

  describe('validateAddCredentialOptions', () => {
    // AC23: Required fields validated
    it('returns error for missing required fields', () => {
      const requiredFields: { field: keyof AddCredentialOptions; error: string }[] = [
        { field: 'name', error: '--name is required' },
        { field: 'apiKey', error: '--api-key is required' },
      ];

      for (const { field, error } of requiredFields) {
        const opts = { ...validCredentialOptions, [field]: undefined };
        const result = validateAddCredentialOptions(opts);
        expect(result.valid, `Should fail for missing ${String(field)}`).toBe(false);
        expect(result.error).toBe(error);
      }
    });

    // AC25: Valid options pass
    it('passes for valid options', () => {
      expect(validateAddCredentialOptions(validCredentialOptions)).toEqual({ valid: true });
    });
  });

  describe('validateAddAgentOptions import validation', () => {
    const validImportOptions: AddAgentOptions = {
      name: 'ImportedAgent',
      type: 'import',
      framework: 'Strands',
      memory: 'none',
      agentId: 'AGENT123',
      agentAliasId: 'ALIAS456',
      region: 'us-east-1',
    };

    it('passes for valid import options', () => {
      const result = validateAddAgentOptions({ ...validImportOptions });
      expect(result).toEqual({ valid: true });
    });

    it('requires --agent-id for import path', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, agentId: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--agent-id');
    });

    it('requires --agent-alias-id for import path', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, agentAliasId: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--agent-alias-id');
    });

    it('requires --region for import path', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, region: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--region');
    });

    it('requires --framework for import path', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, framework: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--framework');
    });

    it('only allows Strands or LangChain_LangGraph for import', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, framework: 'GoogleADK' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Strands or LangChain_LangGraph');
    });

    it('requires --memory for import path', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, memory: undefined });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--memory');
    });

    it('forces modelProvider to Bedrock and language to Python', () => {
      const opts = { ...validImportOptions };
      validateAddAgentOptions(opts);
      expect(opts.modelProvider).toBe('Bedrock');
      expect(opts.language).toBe('Python');
    });

    it('accepts LangChain_LangGraph framework', () => {
      const result = validateAddAgentOptions({ ...validImportOptions, framework: 'LangChain_LangGraph' });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAddAgentOptions protocol validation', () => {
    it('MCP: succeeds with just name and language', () => {
      const result = validateAddAgentOptions({
        name: 'McpAgent',
        type: 'create',
        language: 'Python',
        protocol: 'MCP',
      });
      expect(result.valid).toBe(true);
    });

    it('MCP: fails with --framework', () => {
      const result = validateAddAgentOptions({
        name: 'McpAgent',
        type: 'create',
        language: 'Python',
        protocol: 'MCP',
        framework: 'Strands',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable for MCP protocol');
    });

    it('MCP: fails with --model-provider', () => {
      const result = validateAddAgentOptions({
        name: 'McpAgent',
        type: 'create',
        language: 'Python',
        protocol: 'MCP',
        modelProvider: 'Bedrock',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable for MCP protocol');
    });

    it('MCP: fails with --memory (non-none)', () => {
      const result = validateAddAgentOptions({
        name: 'McpAgent',
        type: 'create',
        language: 'Python',
        protocol: 'MCP',
        memory: 'shortTerm',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not applicable for MCP protocol');
    });

    it('A2A: succeeds with --framework Strands', () => {
      const result = validateAddAgentOptions({
        name: 'A2aAgent',
        type: 'byo',
        language: 'Python',
        protocol: 'A2A',
        framework: 'Strands',
        modelProvider: 'Bedrock',
        codeLocation: '/path/to/code',
      });
      expect(result.valid).toBe(true);
    });

    it('A2A: fails with --framework OpenAIAgents', () => {
      const result = validateAddAgentOptions({
        name: 'A2aAgent',
        type: 'byo',
        language: 'Python',
        protocol: 'A2A',
        framework: 'OpenAIAgents',
        modelProvider: 'OpenAI',
        codeLocation: '/path/to/code',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not support A2A protocol');
    });

    it('invalid protocol fails validation', () => {
      const result = validateAddAgentOptions({
        name: 'BadAgent',
        type: 'create',
        language: 'Python',
        protocol: 'GRPC' as any,
        framework: 'Strands',
        modelProvider: 'Bedrock',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid protocol');
    });

    it('default (no --protocol) works as before (HTTP)', () => {
      const result = validateAddAgentOptions({
        ...validAgentOptionsByo,
        protocol: undefined,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAddCredentialOptions OAuth', () => {
    it('passes for valid OAuth identity', () => {
      const result = validateAddCredentialOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
        clientId: 'client123',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(true);
    });

    it('returns error for OAuth without discovery-url', () => {
      const result = validateAddCredentialOptions({
        name: 'my-oauth',
        type: 'oauth',
        clientId: 'client123',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--discovery-url');
    });

    it('returns error for OAuth without client-id', () => {
      const result = validateAddCredentialOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com',
        clientSecret: 'secret456',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--client-id');
    });

    it('returns error for OAuth without client-secret', () => {
      const result = validateAddCredentialOptions({
        name: 'my-oauth',
        type: 'oauth',
        discoveryUrl: 'https://auth.example.com',
        clientId: 'client123',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--client-secret');
    });

    it('still requires api-key for default type', () => {
      const result = validateAddCredentialOptions({ name: 'my-key' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('--api-key');
    });
  });
});

describe('validateAddAgentOptions - VPC validation', () => {
  const baseOptions: AddAgentOptions = {
    name: 'TestAgent',
    type: 'byo',
    language: 'Python',
    framework: 'Strands',
    modelProvider: 'Bedrock',
    build: 'CodeZip',
    codeLocation: './app/test/',
  };

  it('accepts valid VPC options', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      subnets: 'subnet-12345678',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts PUBLIC network mode without VPC options', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'PUBLIC',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid network mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'INVALID',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid network mode');
  });

  it('rejects VPC mode without subnets', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });

  it('rejects VPC mode without security groups', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      subnets: 'subnet-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--security-groups is required');
  });

  it('rejects subnets without VPC mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      subnets: 'subnet-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects security groups without VPC mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });
});

describe('validateAddAgentOptions - lifecycle configuration', () => {
  const baseOptions: AddAgentOptions = {
    name: 'TestAgent',
    type: 'byo',
    language: 'Python',
    framework: 'Strands',
    modelProvider: 'Bedrock',
    build: 'CodeZip',
    codeLocation: './app/test/',
  };

  it('accepts valid idle-timeout', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 900 });
    expect(result.valid).toBe(true);
  });

  it('accepts valid max-lifetime', () => {
    const result = validateAddAgentOptions({ ...baseOptions, maxLifetime: 28800 });
    expect(result.valid).toBe(true);
  });

  it('accepts both when idle <= max', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 600, maxLifetime: 3600 });
    expect(result.valid).toBe(true);
  });

  it('accepts both when idle === max', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 3600, maxLifetime: 3600 });
    expect(result.valid).toBe(true);
  });

  it('rejects idle-timeout below 60', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects idle-timeout above 28800', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects max-lifetime below 60', () => {
    const result = validateAddAgentOptions({ ...baseOptions, maxLifetime: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects max-lifetime above 28800', () => {
    const result = validateAddAgentOptions({ ...baseOptions, maxLifetime: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects idle > max', () => {
    const result = validateAddAgentOptions({ ...baseOptions, idleTimeout: 5000, maxLifetime: 1000 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout must be <= --max-lifetime');
  });

  it('passes without lifecycle options (defaults handled server-side)', () => {
    const result = validateAddAgentOptions(baseOptions);
    expect(result.valid).toBe(true);
  });

  it('accepts lifecycle options for import path', () => {
    const importOptions: AddAgentOptions = {
      name: 'TestAgent',
      type: 'import',
      agentId: 'AGENT123',
      agentAliasId: 'ALIAS123',
      region: 'us-east-1',
      framework: 'Strands',
      memory: 'none',
      idleTimeout: 600,
      maxLifetime: 7200,
    };
    const result = validateAddAgentOptions(importOptions);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid lifecycle for import path', () => {
    const importOptions: AddAgentOptions = {
      name: 'TestAgent',
      type: 'import',
      agentId: 'AGENT123',
      agentAliasId: 'ALIAS123',
      region: 'us-east-1',
      framework: 'Strands',
      memory: 'none',
      idleTimeout: 50000,
    };
    const result = validateAddAgentOptions(importOptions);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });
});
