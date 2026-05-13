import { serializeResult } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { ResourceStatusEntry } from './action';
import { handleProjectStatus, handleRuntimeLookup, loadStatusConfig } from './action';
import { DEPLOYMENT_STATE_COLORS, DEPLOYMENT_STATE_LABELS } from './constants';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

const VALID_RESOURCE_TYPES = [
  'agent',
  'runtime-endpoint',
  'memory',
  'credential',
  'gateway',
  'evaluator',
  'online-eval',
  'policy-engine',
  'policy',
  'config-bundle',
  'ab-test',
] as const;
const VALID_STATES = ['deployed', 'local-only', 'pending-removal'] as const;

interface StatusCliOptions {
  runtimeId?: string;
  target?: string;
  type?: string;
  state?: string;
  runtime?: string;
  json?: boolean;
}

function filterResources(
  resources: ResourceStatusEntry[],
  options: { type?: string; state?: string; runtime?: string }
): ResourceStatusEntry[] {
  let filtered = resources;

  if (options.type) {
    filtered = filtered.filter(r => r.resourceType === options.type);
  }

  if (options.state) {
    filtered = filtered.filter(r => r.deploymentState === options.state);
  }

  if (options.runtime) {
    filtered = filtered.filter(r => r.resourceType !== 'agent' || r.name === options.runtime);
  }

  return filtered;
}

export const registerStatus = (program: Command) => {
  program
    .command('status')
    .alias('s')
    .description(COMMAND_DESCRIPTIONS.status)
    .option('--runtime-id <id>', 'Look up a specific runtime by ID')
    .option('--target <name>', 'Select deployment target')
    .option(
      '--type <type>',
      'Filter by resource type (agent, runtime-endpoint, memory, credential, gateway, evaluator, online-eval, policy-engine, policy, config-bundle, ab-test)'
    )
    .option('--state <state>', 'Filter by deployment state (deployed, local-only, pending-removal)')
    .option('--runtime <name>', 'Filter to a specific runtime')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: StatusCliOptions) => {
      requireProject();

      // Validate --type
      if (cliOptions.type && !(VALID_RESOURCE_TYPES as readonly string[]).includes(cliOptions.type)) {
        render(
          <Text color="red">
            Invalid resource type &apos;{cliOptions.type}&apos;. Valid types: {VALID_RESOURCE_TYPES.join(', ')}
          </Text>
        );
        return;
      }

      // Validate --state
      if (cliOptions.state && !(VALID_STATES as readonly string[]).includes(cliOptions.state)) {
        render(
          <Text color="red">
            Invalid state &apos;{cliOptions.state}&apos;. Valid states: {VALID_STATES.join(', ')}
          </Text>
        );
        return;
      }

      try {
        const context = await loadStatusConfig();

        // Direct runtime lookup by ID
        if (cliOptions.runtimeId) {
          const result = await handleRuntimeLookup(context, {
            agentRuntimeId: cliOptions.runtimeId,
            targetName: cliOptions.target,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result), null, 2));
            return;
          }

          if (!result.success) {
            render(<Text color="red">{result.error.message}</Text>);
            return;
          }

          const runtimeStatus = result.runtimeStatus ? `Runtime status: ${result.runtimeStatus}` : '';

          render(
            <Text>
              AgentCore Status - {result.runtimeId} (target: {result.targetName})
              {runtimeStatus ? ` - ${runtimeStatus}` : ''}
            </Text>
          );
          return;
        }

        // Default path: show all resource types with deployment state
        const result = await handleProjectStatus(context, {
          targetName: cliOptions.target,
        });

        if (cliOptions.json) {
          if (result.success) {
            const filtered = filterResources(result.resources, cliOptions);
            console.log(JSON.stringify({ ...result, resources: filtered }, null, 2));
          } else {
            console.log(JSON.stringify(serializeResult(result), null, 2));
          }
          return;
        }

        if (!result.success) {
          render(<Text color="red">{result.error.message}</Text>);
          return;
        }

        const filtered = filterResources(result.resources, cliOptions);
        const agents = filtered.filter(r => r.resourceType === 'agent');
        const runtimeEndpoints = filtered.filter(r => r.resourceType === 'runtime-endpoint');
        const credentials = filtered.filter(r => r.resourceType === 'credential');
        const memories = filtered.filter(r => r.resourceType === 'memory');
        const gateways = filtered.filter(r => r.resourceType === 'gateway');
        const evaluators = filtered.filter(r => r.resourceType === 'evaluator');
        const onlineEvals = filtered.filter(r => r.resourceType === 'online-eval');
        const policyEngines = filtered.filter(r => r.resourceType === 'policy-engine');
        const policies = filtered.filter(r => r.resourceType === 'policy');
        const configBundles = filtered.filter(r => r.resourceType === 'config-bundle');
        const abTests = filtered.filter(r => r.resourceType === 'ab-test');
        // TODO: Add http-gateway resource type when diffResourceSet for HTTP gateways is added to action.ts

        render(
          <Box flexDirection="column">
            <Text bold>
              AgentCore Status (target: {result.targetName ?? 'No target configured'}
              {result.targetRegion ? `, ${result.targetRegion}` : ''})
            </Text>

            {agents.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Agents</Text>
                {agents.map(entry => {
                  // Find endpoints belonging to this agent
                  const agentEndpoints = runtimeEndpoints.filter(ep => ep.parentName === entry.name);
                  return (
                    <Box key={`${entry.resourceType}-${entry.name}`} flexDirection="column">
                      <ResourceEntry entry={entry} showRuntime />
                      {entry.invocationUrl && (
                        <Text dimColor>
                          {'  '}URL: {entry.invocationUrl}
                        </Text>
                      )}
                      {agentEndpoints.map(ep => (
                        <Text key={`${ep.parentName}/${ep.name}`}>
                          {'    '}◉ {ep.name} <Text dimColor>{ep.detail}</Text>{' '}
                          <Text color={DEPLOYMENT_STATE_COLORS[ep.deploymentState] ?? 'gray'}>
                            [{DEPLOYMENT_STATE_LABELS[ep.deploymentState] ?? ep.deploymentState}]
                          </Text>
                        </Text>
                      ))}
                    </Box>
                  );
                })}
              </Box>
            )}

            {agents.length === 0 && runtimeEndpoints.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Runtime Endpoints</Text>
                {runtimeEndpoints.map(ep => (
                  <Text key={`${ep.parentName}/${ep.name}`}>
                    {'  '}◉ {ep.parentName}/{ep.name} <Text dimColor>{ep.detail}</Text>{' '}
                    <Text color={DEPLOYMENT_STATE_COLORS[ep.deploymentState] ?? 'gray'}>
                      [{DEPLOYMENT_STATE_LABELS[ep.deploymentState] ?? ep.deploymentState}]
                    </Text>
                  </Text>
                ))}
              </Box>
            )}

            {memories.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Memories</Text>
                {memories.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {credentials.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Credentials</Text>
                {credentials.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {gateways.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Gateways</Text>
                {gateways.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {evaluators.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Evaluators</Text>
                {evaluators.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {onlineEvals.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Online Eval Configs</Text>
                {onlineEvals.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {policyEngines.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Policy Engines</Text>
                {policyEngines.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {policies.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Policies</Text>
                {policies.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.detail}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {configBundles.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Config Bundles</Text>
                {configBundles.map(entry => (
                  <ResourceEntry key={`${entry.resourceType}-${entry.name}`} entry={entry} />
                ))}
              </Box>
            )}

            {abTests.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>AB Tests</Text>
                {abTests.map(entry => (
                  <Box key={`${entry.resourceType}-${entry.name}`} flexDirection="column">
                    <ResourceEntry entry={entry} />
                    {entry.invocationUrl && (
                      <Text dimColor>
                        {'  '}Invocation URL: {entry.invocationUrl}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}

            {/* TODO: Add HTTP Gateways render section when diffResourceSet is added to action.ts */}

            {filtered.length === 0 && <Text dimColor>No resources match the given filters.</Text>}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};

function ResourceEntry({ entry, showRuntime }: { entry: ResourceStatusEntry; showRuntime?: boolean }) {
  return (
    <Text>
      {'  '}
      {entry.name}:{' '}
      <Text color={DEPLOYMENT_STATE_COLORS[entry.deploymentState] ?? 'gray'}>
        {DEPLOYMENT_STATE_LABELS[entry.deploymentState] ?? entry.deploymentState}
      </Text>
      {entry.detail &&
        (showRuntime ? <Text> - Runtime: {entry.detail}</Text> : <Text dimColor> ({entry.detail})</Text>)}
      {entry.identifier && <Text dimColor> ({entry.identifier})</Text>}
      {entry.error && <Text color="red"> - Error: {entry.error}</Text>}
    </Text>
  );
}
