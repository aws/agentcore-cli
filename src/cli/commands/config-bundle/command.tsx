import {
  getConfigurationBundleVersion,
  listConfigurationBundleVersions,
  updateConfigurationBundle,
} from '../../aws/agentcore-config-bundles';
import type {
  ConfigurationBundleVersionSummary,
  ListConfigurationBundleVersionsFilter,
} from '../../aws/agentcore-config-bundles';
import { getErrorMessage } from '../../errors';
import { deepDiff } from '../../operations/config-bundle/diff-versions';
import { resolveBundleByName } from '../../operations/config-bundle/resolve-bundle';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(ts: string): string {
  const num = Number(ts);
  if (isNaN(num)) return ts;
  // API returns epoch seconds; convert to ms if needed
  const ms = num < 1e12 ? num * 1000 : num;
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

async function resolveRegion(): Promise<string> {
  const { ConfigIO } = await import('../../../lib');
  const configIO = new ConfigIO();
  const targets = await configIO.resolveAWSDeploymentTargets();
  if (targets.length === 0) {
    throw new Error('No AWS deployment targets configured. Run `agentcore deploy` first.');
  }
  return targets[0]!.region;
}

// ============================================================================
// Version list
// ============================================================================

async function handleVersions(options: {
  bundle: string;
  branch?: string;
  latestPerBranch?: boolean;
  createdBy?: string;
  region?: string;
  json?: boolean;
}) {
  const region = options.region ?? (await resolveRegion());
  const resolved = await resolveBundleByName(options.bundle, region);

  const filter: ListConfigurationBundleVersionsFilter = {};
  if (options.branch) filter.branchName = options.branch;
  if (options.latestPerBranch) filter.latestPerBranch = true;
  if (options.createdBy) filter.createdByName = options.createdBy;
  const hasFilter = Object.keys(filter).length > 0;

  // Paginate to collect all versions
  const allVersions: ConfigurationBundleVersionSummary[] = [];
  let nextToken: string | undefined;
  do {
    const result = await listConfigurationBundleVersions({
      region,
      bundleId: resolved.bundleId,
      maxResults: 50,
      nextToken,
      ...(hasFilter && { filter }),
    });
    allVersions.push(...result.versions);
    nextToken = result.nextToken;
  } while (nextToken);

  // Sort by creation time, newest first
  allVersions.sort((a, b) => Number(b.versionCreatedAt) - Number(a.versionCreatedAt));

  return { versions: allVersions, bundleName: options.bundle, bundleId: resolved.bundleId };
}

// ============================================================================
// Diff
// ============================================================================

async function handleDiff(options: { bundle: string; from: string; to: string; region?: string }) {
  const region = options.region ?? (await resolveRegion());
  const resolved = await resolveBundleByName(options.bundle, region);

  const [fromVersion, toVersion] = await Promise.all([
    getConfigurationBundleVersion({ region, bundleId: resolved.bundleId, versionId: options.from }),
    getConfigurationBundleVersion({ region, bundleId: resolved.bundleId, versionId: options.to }),
  ]);

  const diffs = deepDiff(fromVersion.components, toVersion.components);

  return { fromVersion, toVersion, diffs };
}

// ============================================================================
// Command registration
// ============================================================================

export const registerConfigBundle = (program: Command) => {
  const cmd = program
    .command('config-bundle')
    .alias('cb')
    .description('[preview] Manage configuration bundles (use bundle name from agentcore.json, not the ID)');

  // --- versions ---
  cmd
    .command('versions')
    .description('List version history for a configuration bundle')
    .requiredOption('--bundle <name>', 'Bundle name as defined in agentcore.json (e.g. "MyBundle")')
    .option('--branch <name>', 'Filter by branch name')
    .option('--latest-per-branch', 'Show only the latest version per branch')
    .option('--created-by <name>', 'Filter by creator name (e.g. "user", "recommendation")')
    .option('--region <region>', 'AWS region override')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        bundle: string;
        branch?: string;
        latestPerBranch?: boolean;
        createdBy?: string;
        region?: string;
        json?: boolean;
      }) => {
        requireProject();
        try {
          const result = await handleVersions(cliOptions);

          if (cliOptions.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (result.versions.length === 0) {
            render(<Text color="yellow">No versions found for bundle &quot;{cliOptions.bundle}&quot;.</Text>);
            return;
          }

          // Group by branch
          const byBranch = new Map<string, ConfigurationBundleVersionSummary[]>();
          for (const v of result.versions) {
            const branch = v.lineageMetadata?.branchName ?? 'unknown';
            if (!byBranch.has(branch)) byBranch.set(branch, []);
            byBranch.get(branch)!.push(v);
          }

          render(
            <Box flexDirection="column">
              <Text bold>
                {result.bundleName} — {result.versions.length} version(s)
              </Text>
              <Text> </Text>
              {[...byBranch.entries()].map(([branch, versions]) => (
                <Box key={branch} flexDirection="column" marginBottom={1}>
                  <Text bold color="cyan">
                    Branch: {branch}
                  </Text>
                  {versions.map((v, i) => {
                    const meta = v.lineageMetadata;
                    const creator = meta?.createdBy?.name ?? 'unknown';
                    const message = meta?.commitMessage ?? '';
                    const isLast = i === versions.length - 1;
                    const connector = isLast ? '└' : '├';
                    return (
                      <Box key={v.versionId} flexDirection="column">
                        <Text>
                          {connector} <Text color="green">{v.versionId}</Text>{' '}
                          <Text dimColor>{formatTimestamp(v.versionCreatedAt)}</Text>{' '}
                          {message && <Text>&quot;{message}&quot;</Text>}
                        </Text>
                        <Text>
                          {isLast ? ' ' : '│'} <Text dimColor>by: {creator}</Text>
                          {meta?.parentVersionIds?.length ? (
                            <Text dimColor> (parent: {meta.parentVersionIds.join(', ')})</Text>
                          ) : null}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              ))}
              <Text dimColor>Use --json for complete output</Text>
            </Box>
          );
        } catch (error) {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          process.exit(1);
        }
      }
    );

  // --- diff ---
  cmd
    .command('diff')
    .description('Diff two versions of a configuration bundle (get version IDs from `cb versions`)')
    .requiredOption('--bundle <name>', 'Bundle name as defined in agentcore.json (e.g. "MyBundle")')
    .requiredOption('--from <id>', 'Source version ID (from `config-bundle versions --json`)')
    .requiredOption('--to <id>', 'Target version ID (from `config-bundle versions --json`)')
    .option('--region <region>', 'AWS region override')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { bundle: string; from: string; to: string; region?: string; json?: boolean }) => {
      requireProject();
      try {
        const result = await handleDiff(cliOptions);

        if (cliOptions.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const fromMeta = result.fromVersion.lineageMetadata;
        const toMeta = result.toVersion.lineageMetadata;

        render(
          <Box flexDirection="column">
            <Text bold>
              Diff: {result.fromVersion.versionId} → {result.toVersion.versionId}
            </Text>
            <Text dimColor>
              From: {fromMeta?.commitMessage ?? '(no message)'} ({formatTimestamp(result.fromVersion.versionCreatedAt)})
            </Text>
            <Text dimColor>
              To: {toMeta?.commitMessage ?? '(no message)'} ({formatTimestamp(result.toVersion.versionCreatedAt)})
            </Text>
            <Text> </Text>
            {result.diffs.length === 0 ? (
              <Text color="green">No differences found.</Text>
            ) : (
              <>
                <Text>{result.diffs.length} change(s):</Text>
                <Text> </Text>
                {result.diffs.map((d, i) => (
                  <Box key={i} flexDirection="column" marginBottom={1}>
                    <Text bold>{d.path}</Text>
                    {d.type === 'added' && <Text color="green">+ {JSON.stringify(d.newValue)}</Text>}
                    {d.type === 'removed' && <Text color="red">- {JSON.stringify(d.oldValue)}</Text>}
                    {d.type === 'changed' && (
                      <>
                        <Text color="red">- {JSON.stringify(d.oldValue)}</Text>
                        <Text color="green">+ {JSON.stringify(d.newValue)}</Text>
                      </>
                    )}
                  </Box>
                ))}
              </>
            )}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });

  // --- create-branch ---
  cmd
    .command('create-branch')
    .description('Create a new branch on an existing configuration bundle')
    .requiredOption('--bundle <name>', 'Bundle name as defined in agentcore.json (e.g. "MyBundle")')
    .requiredOption('--branch <name>', 'Name for the new branch')
    .option('--from <versionId>', 'Parent version ID to branch from (defaults to latest version)')
    .option('--commit-message <text>', 'Commit message for the branch point')
    .option('--region <region>', 'AWS region override')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        bundle: string;
        branch: string;
        from?: string;
        commitMessage?: string;
        region?: string;
        json?: boolean;
      }) => {
        requireProject();
        try {
          const region = cliOptions.region ?? (await resolveRegion());
          const resolved = await resolveBundleByName(cliOptions.bundle, region);

          // Determine parent version
          let parentVersionId = cliOptions.from;
          if (!parentVersionId) {
            const versions = await listConfigurationBundleVersions({
              region,
              bundleId: resolved.bundleId,
              maxResults: 50,
            });
            if (versions.versions.length === 0) {
              throw new Error(`No versions found for bundle "${cliOptions.bundle}".`);
            }
            // Sort descending by creation time to get the latest version
            const sorted = [...versions.versions].sort(
              (a, b) => new Date(b.versionCreatedAt).getTime() - new Date(a.versionCreatedAt).getTime()
            );
            parentVersionId = sorted[0]!.versionId;
          }

          // Get the parent version's components to carry forward
          const parentVersion = await getConfigurationBundleVersion({
            region,
            bundleId: resolved.bundleId,
            versionId: parentVersionId,
          });

          const result = await updateConfigurationBundle({
            region,
            bundleId: resolved.bundleId,
            components: parentVersion.components,
            parentVersionIds: [parentVersionId],
            branchName: cliOptions.branch,
            commitMessage: cliOptions.commitMessage ?? `Create branch ${cliOptions.branch}`,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          render(
            <Box flexDirection="column">
              <Text bold color="green">
                Branch &quot;{cliOptions.branch}&quot; created on bundle &quot;{cliOptions.bundle}&quot;
              </Text>
              <Text>
                Version: <Text color="green">{result.versionId}</Text>
              </Text>
              <Text dimColor>Parent: {parentVersionId}</Text>
            </Box>
          );
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          }
          process.exit(1);
        }
      }
    );

  return cmd;
};
