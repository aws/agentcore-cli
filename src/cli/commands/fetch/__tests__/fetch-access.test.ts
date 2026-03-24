import { registerFetch } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchGatewayToken = vi.fn();
const mockListGateways = vi.fn();
const mockRequireProject = vi.fn();
const mockRender = vi.fn();

vi.mock('../../../operations/fetch-access', () => ({
  fetchGatewayToken: (...args: unknown[]) => mockFetchGatewayToken(...args),
  listGateways: (...args: unknown[]) => mockListGateways(...args),
}));

vi.mock('../../../tui/guards', () => ({
  requireProject: (...args: unknown[]) => mockRequireProject(...args),
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
  Box: 'Box',
  Text: 'Text',
}));

const jwtResult = {
  url: 'https://gw.example.com',
  authType: 'CUSTOM_JWT',
  token: 'test-token',
  expiresIn: 3600,
};

const noneResult = {
  url: 'https://gw.example.com',
  authType: 'NONE',
  message: 'No authentication required.',
};

describe('registerFetch', () => {
  let program: Command;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerFetch(program);

    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockLog.mockRestore();
    vi.clearAllMocks();
  });

  it('registers fetch command with access subcommand', () => {
    const fetchCmd = program.commands.find(c => c.name() === 'fetch');
    expect(fetchCmd).toBeDefined();

    const accessCmd = fetchCmd!.commands.find(c => c.name() === 'access');
    expect(accessCmd).toBeDefined();
  });

  it('outputs valid JSON for CUSTOM_JWT result when --json flag is used', async () => {
    mockFetchGatewayToken.mockResolvedValue(jwtResult);

    await program.parseAsync(['fetch', 'access', '--name', 'myGateway', '--json'], { from: 'user' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.success).toBe(true);
    expect(output.url).toBe('https://gw.example.com');
    expect(output.authType).toBe('CUSTOM_JWT');
    expect(output.token).toBe('test-token');
    expect(output.expiresIn).toBe(3600);
  });

  it('outputs valid JSON with no token field for NONE gateway when --json flag is used', async () => {
    mockFetchGatewayToken.mockResolvedValue(noneResult);

    await program.parseAsync(['fetch', 'access', '--name', 'myGateway', '--json'], { from: 'user' });

    expect(mockLog).toHaveBeenCalledTimes(1);
    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.success).toBe(true);
    expect(output.url).toBe('https://gw.example.com');
    expect(output.authType).toBe('NONE');
    expect(output.token).toBeUndefined();
    expect(output.message).toBe('No authentication required.');
  });

  it('shows error with available gateways when --name is missing and gateways exist', async () => {
    mockListGateways.mockResolvedValue([
      { name: 'gateway-one', authType: 'CUSTOM_JWT' },
      { name: 'gateway-two', authType: 'NONE' },
    ]);

    await expect(program.parseAsync(['fetch', 'access'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRender).toHaveBeenCalled();
    const renderArg = mockRender.mock.calls[0]![0];
    expect(JSON.stringify(renderArg)).toContain('Missing required option');
  });

  it('shows deploy message when --name is missing and no gateways are deployed', async () => {
    mockListGateways.mockResolvedValue([]);

    await expect(program.parseAsync(['fetch', 'access'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRender).toHaveBeenCalled();
    const renderArg = mockRender.mock.calls[0]![0];
    expect(JSON.stringify(renderArg)).toContain('agentcore deploy');
  });

  it('outputs JSON error with available gateways when --name is missing and --json flag is used', async () => {
    mockListGateways.mockResolvedValue([
      { name: 'gateway-one', authType: 'CUSTOM_JWT' },
      { name: 'gateway-two', authType: 'NONE' },
    ]);

    await expect(program.parseAsync(['fetch', 'access', '--json'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.success).toBe(false);
    expect(output.error).toBe('Missing required option: --name');
    expect(output.availableGateways).toEqual([
      { name: 'gateway-one', authType: 'CUSTOM_JWT' },
      { name: 'gateway-two', authType: 'NONE' },
    ]);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('outputs JSON deploy message when --name is missing, --json flag is used, and no gateways deployed', async () => {
    mockListGateways.mockResolvedValue([]);

    await expect(program.parseAsync(['fetch', 'access', '--json'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.success).toBe(false);
    expect(output.error).toContain('agentcore deploy');
    expect(output.availableGateways).toBeUndefined();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('outputs JSON error when fetchGatewayToken throws and --json flag is used', async () => {
    mockFetchGatewayToken.mockRejectedValue(new Error('Token fetch failed'));

    await expect(
      program.parseAsync(['fetch', 'access', '--name', 'myGateway', '--json'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const output = JSON.parse(mockLog.mock.calls[0][0]);
    expect(output.success).toBe(false);
    expect(output.error).toBe('Token fetch failed');
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('shows error message when fetchGatewayToken throws', async () => {
    mockFetchGatewayToken.mockRejectedValue(new Error('Token fetch failed'));

    await expect(program.parseAsync(['fetch', 'access', '--name', 'myGateway'], { from: 'user' })).rejects.toThrow(
      'process.exit'
    );

    expect(mockRender).toHaveBeenCalled();
    const renderArg = mockRender.mock.calls[0]![0];
    expect(JSON.stringify(renderArg)).toContain('Token fetch failed');
  });
});
