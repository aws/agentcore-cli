/**
 * Hook for the Config Bundle Hub — reads bundles from project config
 * and enriches deployed ones with version metadata from the API.
 */
import type { ConfigurationBundleVersionSummary } from '../../../../cli/aws/agentcore-config-bundles';
import {
  listConfigurationBundleVersions,
  listConfigurationBundles,
} from '../../../../cli/aws/agentcore-config-bundles';
import { ConfigIO } from '../../../../lib';
import { getBundleNameVariants } from '../../../operations/config-bundle/bundle-name-variants';
import { useEffect, useRef, useState } from 'react';

export interface BundleWithMeta {
  bundleId: string;
  bundleArn: string;
  bundleName: string;
  description?: string;
  versionCount: number;
  branches: string[];
  lastUpdated?: string;
}

export interface ConfigBundleHubState {
  bundles: BundleWithMeta[];
  isLoading: boolean;
  error?: string;
  region: string;
}

export function useConfigBundleHub(): ConfigBundleHubState {
  const [bundles, setBundles] = useState<BundleWithMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [region, setRegion] = useState('us-east-1');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function load() {
      setIsLoading(true);
      setError(undefined);
      try {
        const configIO = new ConfigIO();
        const [projectSpec, deployedState, targets] = await Promise.all([
          configIO.readProjectSpec(),
          configIO.readDeployedState(),
          configIO.resolveAWSDeploymentTargets(),
        ]);

        if (targets.length === 0) {
          if (mountedRef.current) {
            setError('No AWS deployment targets configured.');
            setIsLoading(false);
          }
          return;
        }
        const resolvedRegion = targets[0]!.region;
        if (mountedRef.current) setRegion(resolvedRegion);

        // Get config bundles from project config (agentcore.json)
        const projectBundles = projectSpec.configBundles ?? [];
        if (projectBundles.length === 0) {
          if (mountedRef.current) {
            setBundles([]);
            setIsLoading(false);
          }
          return;
        }

        // Get deployed state to look up bundleIds
        const deployedBundles =
          Object.values(deployedState.targets).find(t => t.resources?.configBundles)?.resources?.configBundles ?? {};

        // Build bundle list from project config, enriching with deployed version info
        const enriched = await Promise.all(
          projectBundles.map(async (bundleSpec): Promise<BundleWithMeta> => {
            const deployed = deployedBundles[bundleSpec.name];
            if (!deployed) {
              // Not yet deployed — show from project config only
              return {
                bundleId: '',
                bundleArn: '',
                bundleName: bundleSpec.name,
                description: bundleSpec.description,
                versionCount: 0,
                branches: bundleSpec.branchName ? [bundleSpec.branchName] : [],
              };
            }

            // Deployed — fetch version metadata from API
            // Use a helper that falls back to the list API if the deployed-state bundleId is stale
            let effectiveBundleId = deployed.bundleId;
            let effectiveBundleArn = deployed.bundleArn;

            try {
              const versions = await listConfigurationBundleVersions({
                region: resolvedRegion,
                bundleId: effectiveBundleId,
                maxResults: 50,
              });
              const branchSet = new Set<string>();
              let latestTs = '';
              for (const v of versions.versions) {
                if (v.lineageMetadata?.branchName) branchSet.add(v.lineageMetadata.branchName);
                if (v.versionCreatedAt > latestTs) latestTs = v.versionCreatedAt;
              }
              return {
                bundleId: effectiveBundleId,
                bundleArn: effectiveBundleArn,
                bundleName: bundleSpec.name,
                description: bundleSpec.description,
                versionCount: versions.versions.length,
                branches: [...branchSet],
                lastUpdated: latestTs || undefined,
              };
            } catch {
              // Stale deployed-state ID — try to resolve via list API
              try {
                const allBundles = await listConfigurationBundles({ region: resolvedRegion, maxResults: 100 });
                const nameVariants = getBundleNameVariants(bundleSpec.name, projectSpec.name);
                const match = allBundles.bundles.find(b => nameVariants.includes(b.bundleName));
                if (match) {
                  effectiveBundleId = match.bundleId;
                  effectiveBundleArn = match.bundleArn;
                  const versions = await listConfigurationBundleVersions({
                    region: resolvedRegion,
                    bundleId: effectiveBundleId,
                    maxResults: 50,
                  });
                  const branchSet = new Set<string>();
                  let latestTs = '';
                  for (const v of versions.versions) {
                    if (v.lineageMetadata?.branchName) branchSet.add(v.lineageMetadata.branchName);
                    if (v.versionCreatedAt > latestTs) latestTs = v.versionCreatedAt;
                  }
                  return {
                    bundleId: effectiveBundleId,
                    bundleArn: effectiveBundleArn,
                    bundleName: bundleSpec.name,
                    description: bundleSpec.description,
                    versionCount: versions.versions.length,
                    branches: [...branchSet],
                    lastUpdated: latestTs || undefined,
                  };
                }
              } catch {
                // Both paths failed
              }
              return {
                bundleId: effectiveBundleId,
                bundleArn: effectiveBundleArn,
                bundleName: bundleSpec.name,
                description: bundleSpec.description,
                versionCount: 0,
                branches: [],
              };
            }
          })
        );

        if (mountedRef.current) {
          setBundles(enriched);
          setIsLoading(false);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { bundles, isLoading, error, region };
}

export function useVersionHistory(bundleId: string, region: string) {
  const [versions, setVersions] = useState<ConfigurationBundleVersionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setError(undefined);
      try {
        const allVersions: ConfigurationBundleVersionSummary[] = [];
        let nextToken: string | undefined;
        do {
          const result = await listConfigurationBundleVersions({
            region,
            bundleId,
            maxResults: 50,
            nextToken,
          });
          allVersions.push(...result.versions);
          nextToken = result.nextToken;
        } while (nextToken);

        allVersions.sort((a, b) => Number(b.versionCreatedAt) - Number(a.versionCreatedAt));
        setVersions(allVersions);
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    }

    void load();
  }, [bundleId, region]);

  return { versions, isLoading, error };
}
