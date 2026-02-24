import { previewRemoveCredential } from '../remove-identity.js';
import { describe, expect, it, vi } from 'vitest';

const { mockReadProjectSpec, mockConfigExists, mockReadMcpSpec } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockConfigExists: vi.fn(),
  mockReadMcpSpec: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    configExists = mockConfigExists;
    readMcpSpec = mockReadMcpSpec;
  },
}));

describe('previewRemoveCredential', () => {
  it('shows warning when credential is referenced by gateway targets outboundAuth', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'test-cred', type: 'API_KEY' }],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gateway1',
          targets: [
            {
              name: 'target1',
              outboundAuth: { credentialName: 'test-cred' },
            },
          ],
        },
      ],
    });

    const result = await previewRemoveCredential('test-cred');

    expect(result.summary).toContain(
      'Warning: Credential "test-cred" is referenced by gateway targets: gateway1/target1. Removing it may break these targets.'
    );
  });

  it('lists which targets reference the credential', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'shared-cred', type: 'API_KEY' }],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gateway1',
          targets: [
            { name: 'target1', outboundAuth: { credentialName: 'shared-cred' } },
            { name: 'target2', outboundAuth: { credentialName: 'other-cred' } },
          ],
        },
        {
          name: 'gateway2',
          targets: [{ name: 'target3', outboundAuth: { credentialName: 'shared-cred' } }],
        },
      ],
    });

    const result = await previewRemoveCredential('shared-cred');

    expect(result.summary).toContain(
      'Warning: Credential "shared-cred" is referenced by gateway targets: gateway1/target1, gateway2/target3. Removing it may break these targets.'
    );
  });

  it('shows no warning when credential is not referenced', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'unused-cred', type: 'API_KEY' }],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gateway1',
          targets: [{ name: 'target1', outboundAuth: { credentialName: 'other-cred' } }],
        },
      ],
    });

    const result = await previewRemoveCredential('unused-cred');

    const warningMessage = result.summary.find(s => s.includes('Warning'));
    expect(warningMessage).toBeUndefined();
  });

  it('checks across ALL gateways targets for references', async () => {
    mockReadProjectSpec.mockResolvedValue({
      credentials: [{ name: 'test-cred', type: 'API_KEY' }],
    });
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({
      agentCoreGateways: [
        {
          name: 'gateway1',
          targets: [{ name: 'target1' }],
        },
        {
          name: 'gateway2',
          targets: [{ name: 'target2', outboundAuth: { credentialName: 'test-cred' } }],
        },
        {
          name: 'gateway3',
          targets: [{ name: 'target3' }],
        },
      ],
    });

    const result = await previewRemoveCredential('test-cred');

    expect(result.summary).toContain(
      'Warning: Credential "test-cred" is referenced by gateway targets: gateway2/target2. Removing it may break these targets.'
    );
  });
});
