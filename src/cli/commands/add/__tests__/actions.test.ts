import { buildGatewayTargetConfig } from '../actions.js';
import type { ValidatedAddGatewayTargetOptions } from '../actions.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCreateToolFromWizard = vi.fn().mockResolvedValue({ toolName: 'test', projectPath: '/tmp' });
const mockCreateExternalGatewayTarget = vi.fn().mockResolvedValue({ toolName: 'test', projectPath: '' });

vi.mock('../../../operations/mcp/create-mcp', () => ({
  createToolFromWizard: (...args: unknown[]) => mockCreateToolFromWizard(...args),
  createExternalGatewayTarget: (...args: unknown[]) => mockCreateExternalGatewayTarget(...args),
  createGatewayFromWizard: vi.fn(),
}));

describe('buildGatewayTargetConfig', () => {
  it('maps name, gateway, language correctly', () => {
    const options: ValidatedAddGatewayTargetOptions = {
      name: 'test-tool',
      language: 'Python',
      gateway: 'my-gateway',
      host: 'Lambda',
    };

    const config = buildGatewayTargetConfig(options);

    expect(config.name).toBe('test-tool');
    expect(config.language).toBe('Python');
    expect(config.gateway).toBe('my-gateway');
  });

  it('sets outboundAuth when credential provided with type != NONE', () => {
    const options: ValidatedAddGatewayTargetOptions = {
      name: 'test-tool',
      language: 'Python',
      gateway: 'my-gateway',
      host: 'Lambda',
      outboundAuthType: 'API_KEY',
      credentialName: 'my-cred',
    };

    const config = buildGatewayTargetConfig(options);

    expect(config.outboundAuth).toEqual({
      type: 'API_KEY',
      credentialName: 'my-cred',
    });
  });

  it('sets endpoint for existing-endpoint source', () => {
    const options: ValidatedAddGatewayTargetOptions = {
      name: 'test-tool',
      language: 'Python',
      gateway: 'my-gateway',
      host: 'Lambda',
      source: 'existing-endpoint',
      endpoint: 'https://api.example.com',
    };

    const config = buildGatewayTargetConfig(options);

    expect(config.source).toBe('existing-endpoint');
    expect(config.endpoint).toBe('https://api.example.com');
  });

  it('omits outboundAuth when type is NONE', () => {
    const options: ValidatedAddGatewayTargetOptions = {
      name: 'test-tool',
      language: 'Python',
      gateway: 'my-gateway',
      host: 'Lambda',
      outboundAuthType: 'NONE',
    };

    const config = buildGatewayTargetConfig(options);

    expect(config.outboundAuth).toBeUndefined();
  });
});

// Dynamic import to pick up mocks
const { handleAddGatewayTarget } = await import('../actions.js');

describe('handleAddGatewayTarget', () => {
  afterEach(() => vi.clearAllMocks());

  it('routes existing-endpoint to createExternalGatewayTarget', async () => {
    const options: ValidatedAddGatewayTargetOptions = {
      name: 'test-tool',
      language: 'Other',
      host: 'Lambda',
      source: 'existing-endpoint',
      endpoint: 'https://example.com/mcp',
      gateway: 'my-gw',
    };

    await handleAddGatewayTarget(options);

    expect(mockCreateExternalGatewayTarget).toHaveBeenCalledOnce();
    expect(mockCreateToolFromWizard).not.toHaveBeenCalled();
  });
});
