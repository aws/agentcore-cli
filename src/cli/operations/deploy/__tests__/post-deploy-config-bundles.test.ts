import type { AgentCoreProjectSpec, DeployedState } from '../../../../schema';
import { resolveConfigBundleComponentKeys, setupConfigBundles } from '../post-deploy-config-bundles.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateConfigurationBundle,
  mockDeleteConfigurationBundle,
  mockGetConfigurationBundleVersion,
  mockListConfigurationBundleVersions,
  mockListConfigurationBundles,
  mockUpdateConfigurationBundle,
} = vi.hoisted(() => ({
  mockCreateConfigurationBundle: vi.fn(),
  mockDeleteConfigurationBundle: vi.fn(),
  mockGetConfigurationBundleVersion: vi.fn(),
  mockListConfigurationBundleVersions: vi.fn(),
  mockListConfigurationBundles: vi.fn(),
  mockUpdateConfigurationBundle: vi.fn(),
}));

vi.mock('../../../aws/agentcore-config-bundles', () => ({
  createConfigurationBundle: mockCreateConfigurationBundle,
  deleteConfigurationBundle: mockDeleteConfigurationBundle,
  getConfigurationBundleVersion: mockGetConfigurationBundleVersion,
  listConfigurationBundleVersions: mockListConfigurationBundleVersions,
  listConfigurationBundles: mockListConfigurationBundles,
  updateConfigurationBundle: mockUpdateConfigurationBundle,
}));

const REGION = 'us-west-2';

function makeProjectSpec(configBundles: Record<string, unknown>[]) {
  return { name: 'TestProject', configBundles } as any;
}

describe('setupConfigBundles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create new bundle', () => {
    it('should create a new bundle when not in existingBundles and not found by name', async () => {
      mockListConfigurationBundles.mockResolvedValue({ bundles: [] });
      mockCreateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-new',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-new',
        versionId: 'v-1',
      });

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components: { foo: { type: 'inline', value: 'bar' } } },
        ]),
      });

      expect(mockCreateConfigurationBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          region: REGION,
          bundleName: 'TestProjectMyBundle',
          components: { foo: { type: 'inline', value: 'bar' } },
          commitMessage: 'Create MyBundle',
        })
      );
      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ bundleName: 'MyBundle', status: 'created', bundleId: 'b-new' });
      expect(result.configBundles.MyBundle).toEqual({
        bundleId: 'b-new',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-new',
        versionId: 'v-1',
      });
    });
  });

  describe('update existing bundle', () => {
    it('should update an existing bundle when components have changed', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      mockGetConfigurationBundleVersion.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-1',
        components: { foo: { type: 'inline', value: 'old' } },
        description: undefined,
        lineageMetadata: { branchName: 'main' },
      });

      mockUpdateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-2',
      });

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components: { foo: { type: 'inline', value: 'new' } } },
        ]),
        existingBundles,
      });

      expect(mockUpdateConfigurationBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          region: REGION,
          bundleId: 'b-123',
          components: { foo: { type: 'inline', value: 'new' } },
          parentVersionIds: ['v-1'],
          branchName: 'main',
          commitMessage: 'Update MyBundle',
        })
      );
      expect(result.results[0]).toMatchObject({ status: 'updated', versionId: 'v-2' });
      expect(result.hasErrors).toBe(false);
    });
  });

  describe('skip unchanged bundle', () => {
    it('should skip update when components and description are unchanged', async () => {
      const components = { foo: { type: 'inline', value: 'same' } };
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      mockGetConfigurationBundleVersion.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-1',
        components,
        description: 'My desc',
        lineageMetadata: { branchName: 'main' },
      });

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components, description: 'My desc' },
        ]),
        existingBundles,
      });

      expect(mockUpdateConfigurationBundle).not.toHaveBeenCalled();
      expect(mockCreateConfigurationBundle).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ bundleName: 'MyBundle', status: 'skipped', versionId: 'v-1' });
      expect(result.configBundles.MyBundle).toEqual(existingBundles.MyBundle);
    });
  });

  describe('deep equal is key-order-independent', () => {
    it('should skip update when components differ only in key order', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      // API returns keys in one order
      mockGetConfigurationBundleVersion.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-1',
        components: { a: { type: 'inline', value: '1' }, b: { type: 'inline', value: '2' } },
        description: undefined,
        lineageMetadata: { branchName: 'main' },
      });

      // Spec has same keys in different order
      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          {
            name: 'MyBundle',
            components: { b: { type: 'inline', value: '2' }, a: { type: 'inline', value: '1' } },
          },
        ]),
        existingBundles,
      });

      expect(mockUpdateConfigurationBundle).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ status: 'skipped' });
    });
  });

  describe('delete orphaned bundles', () => {
    it('should delete bundles in existingBundles but not in projectSpec', async () => {
      const existingBundles = {
        OrphanBundle: {
          bundleId: 'b-orphan',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-orphan',
          versionId: 'v-1',
        },
      };

      mockDeleteConfigurationBundle.mockResolvedValue(undefined);

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([]),
        existingBundles,
      });

      expect(mockDeleteConfigurationBundle).toHaveBeenCalledWith({
        region: REGION,
        bundleId: 'b-orphan',
      });
      expect(result.results[0]).toMatchObject({ bundleName: 'OrphanBundle', status: 'deleted' });
      expect(result.hasErrors).toBe(false);
    });

    it('should report error status when delete throws', async () => {
      const existingBundles = {
        OrphanBundle: {
          bundleId: 'b-orphan',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-orphan',
          versionId: 'v-1',
        },
      };

      mockDeleteConfigurationBundle.mockRejectedValue(new Error('Access denied'));

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([]),
        existingBundles,
      });

      expect(result.results[0]).toMatchObject({ bundleName: 'OrphanBundle', status: 'error', error: 'Access denied' });
      expect(result.hasErrors).toBe(true);
    });
  });

  describe('uses branch from API when bundleSpec has no branchName', () => {
    it('should use branchName from getConfigurationBundleVersion lineageMetadata', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      mockGetConfigurationBundleVersion.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-1',
        components: { old: { type: 'inline', value: 'data' } },
        description: undefined,
        lineageMetadata: { branchName: 'feature-branch' },
      });

      mockUpdateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-2',
      });

      await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          {
            name: 'MyBundle',
            components: { new: { type: 'inline', value: 'data' } },
            // no branchName specified
          },
        ]),
        existingBundles,
      });

      expect(mockUpdateConfigurationBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'feature-branch',
        })
      );
    });

    it('should prefer bundleSpec branchName over API branchName', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      mockGetConfigurationBundleVersion.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-1',
        components: { old: { type: 'inline', value: 'data' } },
        description: undefined,
        lineageMetadata: { branchName: 'api-branch' },
      });

      mockUpdateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-123',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
        versionId: 'v-2',
      });

      await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          {
            name: 'MyBundle',
            components: { new: { type: 'inline', value: 'data' } },
            branchName: 'spec-branch',
          },
        ]),
        existingBundles,
      });

      expect(mockUpdateConfigurationBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'spec-branch',
        })
      );
    });
  });

  describe('fallback path via findBundleByName', () => {
    it('should fall through to findBundleByName when getConfigurationBundleVersion throws 404', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-old',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-old',
          versionId: 'v-old',
        },
      };

      // First call (existing bundle path) throws 404
      mockGetConfigurationBundleVersion.mockRejectedValueOnce(new Error('404 not found')).mockResolvedValueOnce({
        bundleId: 'b-found',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-found',
        versionId: 'v-latest',
        components: { old: { type: 'inline', value: 'data' } },
        description: undefined,
        lineageMetadata: { branchName: 'main' },
      });

      mockListConfigurationBundles.mockResolvedValue({
        bundles: [{ bundleId: 'b-found', bundleName: 'TestProjectMyBundle' }],
      });

      mockListConfigurationBundleVersions.mockResolvedValue({
        versions: [{ versionId: 'v-latest', versionCreatedAt: 1234567890 }],
      });

      mockUpdateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-found',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-found',
        versionId: 'v-new',
      });

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          {
            name: 'MyBundle',
            components: { new: { type: 'inline', value: 'data' } },
          },
        ]),
        existingBundles,
      });

      expect(mockListConfigurationBundles).toHaveBeenCalledWith({ region: REGION, maxResults: 100 });
      expect(mockListConfigurationBundleVersions).toHaveBeenCalledWith({
        region: REGION,
        bundleId: 'b-found',
      });
      expect(result.results[0]).toMatchObject({ status: 'updated', bundleId: 'b-found', versionId: 'v-new' });
      expect(result.hasErrors).toBe(false);
    });

    it('should create a new bundle when findBundleByName returns nothing after 404', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-old',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-old',
          versionId: 'v-old',
        },
      };

      mockGetConfigurationBundleVersion.mockRejectedValueOnce(new Error('404 not found'));
      mockListConfigurationBundles.mockResolvedValue({ bundles: [] });
      mockCreateConfigurationBundle.mockResolvedValue({
        bundleId: 'b-new',
        bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-new',
        versionId: 'v-1',
      });

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components: { x: { type: 'inline', value: '1' } } },
        ]),
        existingBundles,
      });

      expect(mockCreateConfigurationBundle).toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ status: 'created', bundleId: 'b-new' });
    });
  });

  describe('error handling', () => {
    it('should report error status when create fails', async () => {
      mockListConfigurationBundles.mockResolvedValue({ bundles: [] });
      mockCreateConfigurationBundle.mockRejectedValue(new Error('Service unavailable'));

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components: { x: { type: 'inline', value: '1' } } },
        ]),
      });

      expect(result.results[0]).toMatchObject({
        bundleName: 'MyBundle',
        status: 'error',
        error: 'Service unavailable',
      });
      expect(result.hasErrors).toBe(true);
    });

    it('should report error status when update fails with non-404 error', async () => {
      const existingBundles = {
        MyBundle: {
          bundleId: 'b-123',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-123',
          versionId: 'v-1',
        },
      };

      mockGetConfigurationBundleVersion.mockRejectedValue(new Error('Throttling exception'));

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([
          { name: 'MyBundle', type: 'ConfigurationBundle', components: { x: { type: 'inline', value: '1' } } },
        ]),
        existingBundles,
      });

      expect(result.results[0]).toMatchObject({
        bundleName: 'MyBundle',
        status: 'error',
        error: 'Throttling exception',
      });
      expect(result.hasErrors).toBe(true);
      // Should NOT fall through to findBundleByName
      expect(mockListConfigurationBundles).not.toHaveBeenCalled();
    });

    it('should report error when delete throws an exception', async () => {
      const existingBundles = {
        OrphanBundle: {
          bundleId: 'b-orphan',
          bundleArn: 'arn:aws:agentcore:us-west-2:123:bundle/b-orphan',
          versionId: 'v-1',
        },
      };

      mockDeleteConfigurationBundle.mockRejectedValue(new Error('Network error'));

      const result = await setupConfigBundles({
        region: REGION,
        projectSpec: makeProjectSpec([]),
        existingBundles,
      });

      expect(result.results[0]).toMatchObject({
        bundleName: 'OrphanBundle',
        status: 'error',
        error: 'Network error',
      });
      expect(result.hasErrors).toBe(true);
    });
  });
});

// ── resolveConfigBundleComponentKeys ───────────────────────────────────────

describe('resolveConfigBundleComponentKeys', () => {
  function makeFullProjectSpec(configBundles: AgentCoreProjectSpec['configBundles'] = []): AgentCoreProjectSpec {
    return {
      name: 'TestProject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles,
      httpGateways: [],
      abTests: [],
    };
  }

  function makeDeployedState(targetName: string, resources: Record<string, unknown>): DeployedState {
    return {
      targets: {
        [targetName]: { resources },
      },
    } as unknown as DeployedState;
  }

  it('returns projectSpec unchanged when target has no resources', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{runtime:my-rt}}': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = { targets: {} } as unknown as DeployedState;

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'missing-target');
    expect(result).toBe(spec); // same reference — no transformation
  });

  it('resolves {{runtime:name}} placeholder to runtime ARN', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{runtime:my-agent}}': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', {
      runtimes: { 'my-agent': { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1' } },
    });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    expect(keys).toEqual(['arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1']);
  });

  it('resolves {{gateway:name}} placeholder to HTTP gateway ARN', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{gateway:my-gw}}': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', {
      httpGateways: { 'my-gw': { gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1' } },
    });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    expect(keys).toEqual(['arn:aws:bedrock-agentcore:us-east-1:123:gateway/gw-1']);
  });

  it('resolves {{gateway:name}} placeholder to MCP gateway ARN', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{gateway:my-mcp-gw}}': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', {
      mcp: { gateways: { 'my-mcp-gw': { gatewayArn: 'arn:mcp:gw:resolved' } } },
    });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    expect(keys).toEqual(['arn:mcp:gw:resolved']);
  });

  it('passes through keys that are already ARNs', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { 'arn:existing:key': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', { runtimes: {} });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    expect(keys).toEqual(['arn:existing:key']);
  });

  it('passes through plain string keys that are not placeholders or ARNs', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { 'some-plain-key': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', { runtimes: {} });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    expect(keys).toEqual(['some-plain-key']);
  });

  it('throws when gateway placeholder references non-existent gateway', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{gateway:missing}}': { configuration: {} } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', { httpGateways: {}, mcp: { gateways: {} } });

    expect(() => resolveConfigBundleComponentKeys(spec, deployedState, 'target1')).toThrow(
      'Config bundle references gateway "missing" but it was not found in deployed resources'
    );
  });

  it('throws when runtime placeholder references non-existent runtime', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{runtime:missing}}': { configuration: {} } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', { runtimes: {} });

    expect(() => resolveConfigBundleComponentKeys(spec, deployedState, 'target1')).toThrow(
      'Config bundle references runtime "missing" but it was not found in deployed resources'
    );
  });

  it('handles projectSpec with no configBundles', () => {
    const spec = makeFullProjectSpec([]);
    const deployedState = makeDeployedState('target1', { runtimes: {} });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    expect(result.configBundles).toEqual([]);
  });

  it('does not mutate the original projectSpec', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{runtime:my-rt}}': { configuration: { k: 'v' } } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', {
      runtimes: { 'my-rt': { runtimeArn: 'arn:resolved' } },
    });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    // Original should still have the placeholder
    expect(Object.keys(spec.configBundles![0]!.components)).toEqual(['{{runtime:my-rt}}']);
    // Result should have the resolved key
    expect(Object.keys(result.configBundles![0]!.components)).toEqual(['arn:resolved']);
  });

  it('prefers HTTP gateway over MCP gateway when both exist with same name', () => {
    const spec = makeFullProjectSpec([
      { name: 'b1', components: { '{{gateway:dupe-gw}}': { configuration: {} } } } as any,
    ]);
    const deployedState = makeDeployedState('target1', {
      httpGateways: { 'dupe-gw': { gatewayArn: 'arn:http:gw' } },
      mcp: { gateways: { 'dupe-gw': { gatewayArn: 'arn:mcp:gw' } } },
    });

    const result = resolveConfigBundleComponentKeys(spec, deployedState, 'target1');
    const keys = Object.keys(result.configBundles![0]!.components);
    // HTTP gateway should take precedence (checked first in code)
    expect(keys).toEqual(['arn:http:gw']);
  });
});
