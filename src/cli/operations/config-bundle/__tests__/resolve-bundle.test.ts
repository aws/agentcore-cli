import { resolveBundleByName } from '../resolve-bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListConfigurationBundles, mockListConfigurationBundleVersions } = vi.hoisted(() => ({
  mockListConfigurationBundles: vi.fn(),
  mockListConfigurationBundleVersions: vi.fn(),
}));

vi.mock('../../../aws/agentcore-config-bundles', () => ({
  listConfigurationBundles: mockListConfigurationBundles,
  listConfigurationBundleVersions: mockListConfigurationBundleVersions,
}));

const mockConfigIO = {
  readDeployedState: vi.fn(),
  readProjectSpec: vi.fn(),
} as any;

const REGION = 'us-east-1';

describe('resolveBundleByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigIO.readDeployedState.mockResolvedValue({ targets: {} });
    mockConfigIO.readProjectSpec.mockResolvedValue({ name: 'testproj' });
  });

  it('resolves via deployed state fast path', async () => {
    mockConfigIO.readDeployedState.mockResolvedValue({
      targets: {
        'us-east-1': {
          resources: {
            configBundles: {
              MyBundle: { bundleId: 'bundle-123', bundleArn: 'arn:bundle', versionId: 'v1' },
            },
          },
        },
      },
    });
    mockListConfigurationBundleVersions.mockResolvedValue({
      versions: [{ versionId: 'v2', versionCreatedAt: '2026-01-01T00:00:00Z' }],
    });

    const result = await resolveBundleByName('MyBundle', REGION, mockConfigIO);
    expect(result.bundleId).toBe('bundle-123');
    expect(result.versionId).toBe('v2');
    expect(mockListConfigurationBundles).not.toHaveBeenCalled();
  });

  it('falls back to API when deployed state is empty', async () => {
    mockListConfigurationBundles.mockResolvedValue({
      bundles: [{ bundleId: 'bundle-456', bundleArn: 'arn:bundle-456', bundleName: 'testprojMyBundle' }],
      nextToken: undefined,
    });
    mockListConfigurationBundleVersions.mockResolvedValue({
      versions: [{ versionId: 'v1', versionCreatedAt: '2026-01-01T00:00:00Z' }],
    });

    const result = await resolveBundleByName('MyBundle', REGION, mockConfigIO);
    expect(result.bundleId).toBe('bundle-456');
  });

  it('matches legacy underscore-prefixed name', async () => {
    mockListConfigurationBundles.mockResolvedValue({
      bundles: [{ bundleId: 'bundle-789', bundleArn: 'arn:bundle-789', bundleName: 'testproj_MyBundle' }],
      nextToken: undefined,
    });
    mockListConfigurationBundleVersions.mockResolvedValue({
      versions: [{ versionId: 'v1', versionCreatedAt: '2026-01-01T00:00:00Z' }],
    });

    const result = await resolveBundleByName('MyBundle', REGION, mockConfigIO);
    expect(result.bundleId).toBe('bundle-789');
  });

  it('paginates through multiple pages to find bundle', async () => {
    mockListConfigurationBundles
      .mockResolvedValueOnce({
        bundles: [{ bundleId: 'other-1', bundleArn: 'arn:other', bundleName: 'OtherBundle' }],
        nextToken: 'page2',
      })
      .mockResolvedValueOnce({
        bundles: [{ bundleId: 'bundle-found', bundleArn: 'arn:found', bundleName: 'testprojMyBundle' }],
        nextToken: undefined,
      });
    mockListConfigurationBundleVersions.mockResolvedValue({
      versions: [{ versionId: 'v1', versionCreatedAt: '2026-01-01T00:00:00Z' }],
    });

    const result = await resolveBundleByName('MyBundle', REGION, mockConfigIO);
    expect(result.bundleId).toBe('bundle-found');
    expect(mockListConfigurationBundles).toHaveBeenCalledTimes(2);
  });

  it('throws when bundle not found after all pages', async () => {
    mockListConfigurationBundles.mockResolvedValue({
      bundles: [{ bundleId: 'other', bundleArn: 'arn:other', bundleName: 'SomeOtherBundle' }],
      nextToken: undefined,
    });

    await expect(resolveBundleByName('MyBundle', REGION, mockConfigIO)).rejects.toThrow('not found');
  });
});
