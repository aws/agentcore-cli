import { ConfigIO } from '../../../../lib';
import { getCredentialProvider } from '../../../aws/account';
import { getABTest, updateABTest } from '../../../aws/agentcore-ab-tests';
import type { GetABTestResult } from '../../../aws/agentcore-ab-tests';
import { getOnlineEvaluationConfig } from '../../../aws/agentcore-control';
import { getHttpGateway, listHttpGatewayTargets } from '../../../aws/agentcore-http-gateways';
import { dnsSuffix } from '../../../aws/partition';
import { getErrorMessage } from '../../../errors';
import { GradientText, Screen } from '../../components';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ABTestDetailScreenProps {
  abTestId: string;
  region: string;
  onExit: () => void;
}

/** Derive the gateway URL from a gateway ARN. */
function gatewayUrlFromArn(arn: string): string {
  const parts = arn.split(':');
  const region = parts[3];
  const gatewayId = parts[5]?.split('/')[1];
  if (region && gatewayId) {
    return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix(region)}`;
  }
  return arn;
}

/** Extract the resource ID from an ARN (last segment after / or :). */
function extractId(arn: string): string {
  const slashIdx = arn.lastIndexOf('/');
  if (slashIdx !== -1) return arn.slice(slashIdx + 1);
  const colonIdx = arn.lastIndexOf(':');
  if (colonIdx !== -1) return arn.slice(colonIdx + 1);
  return arn;
}

/** Truncate a version ID to 8 characters. */
function shortVersion(version: string): string {
  return version.slice(0, 8);
}

/** Format a Unix epoch timestamp (seconds) to a UTC date string. */
function formatTimestamp(ts: string | number): string {
  const ms = typeof ts === 'string' ? parseFloat(ts) * 1000 : ts * 1000;
  const d = new Date(ms);
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

/** Build a horizontal rule with optional left label and right label. */
function rule(left?: string, right?: string, width = 48): string {
  if (!left && !right) return '─'.repeat(width);
  const leftPart = left ? `── ${left} ` : '──';
  const rightPart = right ? ` ${right} ──` : '';
  const fillLen = width - leftPart.length - rightPart.length;
  const fill = fillLen > 0 ? '─'.repeat(fillLen) : '';
  return `${leftPart}${fill}${rightPart}`;
}

interface DebugCheckResult {
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

async function runDebugChecks(test: GetABTestResult, region: string): Promise<DebugCheckResult[]> {
  const results: DebugCheckResult[] = [];
  const logsClient = new CloudWatchLogsClient({ region, credentials: getCredentialProvider() });

  // 1. AB Test Status
  results.push({
    label: 'AB Test Status',
    status: test.status === 'ACTIVE' && test.executionStatus === 'RUNNING' ? 'pass' : 'warn',
    detail: `${test.status} / ${test.executionStatus}`,
  });

  // 1b. AB Test Role
  results.push({
    label: 'AB Test Role',
    status: test.roleArn ? 'pass' : 'warn',
    detail: test.roleArn ?? 'No role ARN',
  });

  // 2. Online Eval Config(s)
  const evalConfigArns: { name: string; arn: string }[] =
    'perVariantOnlineEvaluationConfig' in test.evaluationConfig
      ? test.evaluationConfig.perVariantOnlineEvaluationConfig.map(v => ({
          name: v.name,
          arn: v.onlineEvaluationConfigArn,
        }))
      : [{ name: '', arn: test.evaluationConfig.onlineEvaluationConfigArn }];

  for (const { name: variantName, arn: evalArn } of evalConfigArns) {
    const evalConfigId = extractId(evalArn);
    const labelSuffix = variantName ? ` (${variantName})` : '';
    try {
      const evalConfig = await getOnlineEvaluationConfig({ region, configId: evalConfigId });
      results.push({
        label: `Online Eval Config${labelSuffix}`,
        status: evalConfig.executionStatus === 'ENABLED' ? 'pass' : 'fail',
        detail: `${evalConfig.configName} — ${evalConfig.executionStatus}`,
      });
    } catch (err) {
      results.push({ label: `Online Eval Config${labelSuffix}`, status: 'fail', detail: getErrorMessage(err) });
    }
  }

  // 2b. Gateway Role
  const gatewayId = extractId(test.gatewayArn);
  try {
    const gateway = await getHttpGateway({ region, gatewayId });
    results.push({
      label: 'Gateway Role',
      status: gateway.roleArn ? 'pass' : 'warn',
      detail: gateway.roleArn ?? 'No role ARN',
    });
  } catch (err) {
    results.push({ label: 'Gateway Role', status: 'fail', detail: getErrorMessage(err) });
  }

  // 5. Runtime spans — check for experiment metadata per variant in aws/spans
  //    service.name in spans follows the pattern: {projectName}_{agentName}.{endpoint}
  //    We derive the service name prefix from the deployed state runtimeId (strip random suffix).
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const variantNames = test.variants.map(v => v.name);
  let serviceNamePrefix: string | undefined;
  try {
    const configIO = new ConfigIO();
    const deployedState = await configIO.readDeployedState();
    for (const [, target] of Object.entries(deployedState.targets ?? {})) {
      const runtimes = target.resources?.runtimes ?? {};
      const firstRuntime = Object.values(runtimes)[0];
      if (firstRuntime?.runtimeId) {
        // runtimeId is "{projectName}_{agentName}-{randomSuffix}", strip the suffix
        serviceNamePrefix = firstRuntime.runtimeId.replace(/-[^-]+$/, '');
        break;
      }
    }
  } catch {
    // Fall back to abTestArn-only filtering if deployed state isn't readable
  }

  try {
    const baseFilter = serviceNamePrefix ? `"${serviceNamePrefix}"` : '"gen_ai_agent"';
    const [allRuntimeSpans, ...variantSpanResults] = await Promise.all([
      logsClient.send(
        new FilterLogEventsCommand({
          logGroupName: 'aws/spans',
          startTime: twoHoursAgo,
          filterPattern: baseFilter,
          limit: 1,
        })
      ),
      ...variantNames.map(name =>
        logsClient.send(
          new FilterLogEventsCommand({
            logGroupName: 'aws/spans',
            startTime: twoHoursAgo,
            filterPattern: `"${test.abTestArn}" "${name}"`,
            limit: 50,
          })
        )
      ),
    ]);

    const hasRuntimeSpans = (allRuntimeSpans.events?.length ?? 0) > 0;
    const totalExperimentSpans = variantSpanResults.reduce((sum, r) => sum + (r.events?.length ?? 0), 0);

    for (let i = 0; i < variantNames.length; i++) {
      const name = variantNames[i];
      const count = variantSpanResults[i]?.events?.length ?? 0;
      const label = `Runtime Experiment Spans — ${name} (2h)`;

      if (count > 0) {
        results.push({ label, status: 'pass', detail: `${count} spans with experiment metadata` });
      } else if (hasRuntimeSpans) {
        results.push({
          label,
          status: 'warn',
          detail:
            totalExperimentSpans > 0
              ? `No spans for ${name} — traffic may not be reaching this variant`
              : 'Runtime spans found but no experiment metadata — update bedrock-agentcore SDK to the latest version',
        });
      } else {
        results.push({ label, status: 'warn', detail: 'No runtime spans found — send traffic to the gateway first' });
      }
    }
  } catch (err) {
    results.push({ label: 'Runtime Experiment Spans', status: 'fail', detail: getErrorMessage(err) });
  }

  // 6. Eval Results — check each eval config's log group
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  for (const { name: variantName, arn: evalArn } of evalConfigArns) {
    const configId = extractId(evalArn);
    const labelSuffix = variantName ? ` (${variantName})` : '';
    try {
      const evalLogGroup = `/aws/bedrock-agentcore/evaluations/results/${configId}`;

      const [allEvents, taggedEvents] = await Promise.all([
        logsClient.send(new FilterLogEventsCommand({ logGroupName: evalLogGroup, startTime: thirtyMinAgo, limit: 1 })),
        logsClient.send(
          new FilterLogEventsCommand({
            logGroupName: evalLogGroup,
            startTime: thirtyMinAgo,
            filterPattern: `"${test.abTestArn}"`,
            limit: 100,
          })
        ),
      ]);

      const hasResults = (allEvents.events?.length ?? 0) > 0;
      const taggedCount = taggedEvents.events?.length ?? 0;

      if (!hasResults) {
        results.push({
          label: `Eval Results${labelSuffix}`,
          status: 'warn',
          detail: 'No eval results yet — wait ~5m after session timeout for evaluator to process',
        });
      } else {
        results.push({
          label: `Eval Results${labelSuffix}`,
          status: taggedCount > 0 ? 'pass' : 'warn',
          detail:
            taggedCount > 0
              ? `${taggedCount} results tagged with AB test`
              : 'Results exist but none tagged with variant — check gateway trace delivery',
        });
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      results.push({
        label: `Eval Results${labelSuffix}`,
        status: msg.includes('ResourceNotFoundException') ? 'warn' : 'fail',
        detail: msg.includes('ResourceNotFoundException') ? 'Log group not found — evaluator has not run yet' : msg,
      });
    }
  }

  // 6. Aggregation Results
  const metrics = test.results?.evaluatorMetrics ?? [];
  const reporting = metrics.filter(m => m.controlStats?.sampleSize > 0);
  results.push({
    label: 'Aggregation Results',
    status: reporting.length > 0 ? 'pass' : 'warn',
    detail:
      reporting.length > 0
        ? `${reporting.length} evaluator(s) reporting`
        : 'No aggregation data yet — wait ~12-15m after traffic',
  });

  return results;
}

export function ABTestDetailScreen({ abTestId, region, onExit }: ABTestDetailScreenProps) {
  const [test, setTest] = useState<GetABTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingPromote, setConfirmingPromote] = useState(false);
  const [debugResults, setDebugResults] = useState<DebugCheckResult[] | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [targetName, setTargetName] = useState<string>('');

  const hasFetched = useRef(false);
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    const load = async () => {
      try {
        const result = await getABTest({ region, abTestId });
        setTest(result);

        // Fetch gateway target name for invocation URL
        const gwId = extractId(result.gatewayArn);
        try {
          const targets = await listHttpGatewayTargets({ region, gatewayId: gwId, maxResults: 1 });
          const firstTarget = targets.targets[0];
          if (firstTarget) setTargetName(firstTarget.name);
        } catch {
          // Best-effort — URL will show without target path
        }
      } catch (err) {
        setError(getErrorMessage(err));
      }
    };
    void load();
  }, [region, abTestId]);

  const performAction = useCallback(
    async (targetStatus: 'PAUSED' | 'RUNNING' | 'STOPPED', label: string) => {
      setActionMessage(`${label}...`);
      try {
        await updateABTest({ region, abTestId, executionStatus: targetStatus });
        // Poll until status updates or max attempts reached
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const result = await getABTest({ region, abTestId });
          setTest(result);
          if (result.executionStatus === targetStatus) {
            setActionMessage(label.replace('...', 'd').replace('ing', 'ed'));
            return;
          }
        }
        // Final fetch even if status didn't converge
        setActionMessage(label.replace('ing', 'ed'));
      } catch (err: unknown) {
        setActionMessage(`Error: ${getErrorMessage(err)}`);
      }
    },
    [region, abTestId]
  );

  useInput((input, _key) => {
    if (!test) return;

    if (confirmingStop) {
      if (input === 'y' || input === 'Y') {
        setConfirmingStop(false);
        void performAction('STOPPED', 'Stopping');
      } else {
        setConfirmingStop(false);
      }
      return;
    }

    if (confirmingPromote) {
      if (input === 'y' || input === 'Y') {
        setConfirmingPromote(false);
        setActionMessage('Promoting...');
        void (async () => {
          try {
            // Stop the AB test
            await updateABTest({ region, abTestId, executionStatus: 'STOPPED' });
            for (let i = 0; i < 5; i++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const result = await getABTest({ region, abTestId });
              setTest(result);
              if (result.executionStatus === 'STOPPED') break;
            }

            // Apply promotion to agentcore.json
            let promotionDetail = '';
            try {
              const { promoteABTestConfig } = await import('../../../operations/ab-test/promote');
              const promoResult = await promoteABTestConfig(abTestId, test.name);
              promotionDetail = promoResult.promoted
                ? `${promoResult.promotionDetail} Run \`agentcore deploy\` to apply.`
                : promoResult.promotionDetail;
            } catch {
              // Config update failed — still report the stop
            }

            setActionMessage(promotionDetail || 'AB test stopped. Run `agentcore deploy` to apply.');
          } catch (err) {
            setActionMessage(`Error: ${getErrorMessage(err)}`);
          }
        })();
      } else {
        setConfirmingPromote(false);
      }
      return;
    }

    if (input === 'p' || input === 'P') {
      void performAction('PAUSED', 'Pausing');
    }

    if (input === 'r' || input === 'R') {
      void performAction('RUNNING', 'Resuming');
    }

    if (input === 's' || input === 'S') {
      setConfirmingStop(true);
      setActionMessage(null);
    }

    if (input === 'w' || input === 'W') {
      setConfirmingPromote(true);
      setActionMessage(null);
    }

    if (input === 'd' || input === 'D') {
      setDebugLoading(true);
      setDebugResults(null);
      void runDebugChecks(test, region)
        .then(results => {
          setDebugResults(results);
          setDebugLoading(false);
        })
        .catch(() => {
          setDebugResults([{ label: 'Debug', status: 'fail' as const, detail: 'Diagnostics failed to run' }]);
          setDebugLoading(false);
        });
    }
  });

  if (error) {
    return (
      <Screen title="AB Test [preview]" onExit={onExit} helpText="Esc exit">
        <Text color="red">{`Error: ${error}`}</Text>
      </Screen>
    );
  }

  if (!test) {
    return (
      <Screen title="AB Test [preview]" onExit={onExit} helpText="Esc exit">
        <Text dimColor>Loading...</Text>
      </Screen>
    );
  }

  const controlVariant = test.variants.find(v => v.name === 'C');
  const treatmentVariant = test.variants.find(v => v.name === 'T1');

  const executionColor =
    test.executionStatus === 'RUNNING' ? 'green' : test.executionStatus === 'PAUSED' ? 'yellow' : 'red';

  const helpParts: string[] = [];
  if (test.executionStatus === 'RUNNING') {
    helpParts.push('P pause', 'S stop', 'W promote');
  } else if (test.executionStatus === 'PAUSED') {
    helpParts.push('R resume', 'S stop', 'W promote');
  }
  helpParts.push('D debug', 'Esc exit');
  const helpKeys = helpParts.join(' · ');

  // Build status text: only show provisioning status if not ACTIVE
  const statusPrefix = test.status !== 'ACTIVE' ? `${test.status}  ` : '';

  // TODO(post-preview): Re-enable duration display once configurable duration is launched.
  const durationText = '';

  // Column width for side-by-side variants
  const colW = 28;

  return (
    <Screen title={`AB Test [preview]: ${test.name}`} onExit={onExit} helpText={helpKeys}>
      <Box flexDirection="column" paddingX={1}>
        {/* ── Header: Line 1 — status ─────────────────────────── */}
        <Box>
          <Box flexGrow={1}>
            {statusPrefix && <Text bold>{statusPrefix}</Text>}
            <Text color={executionColor} bold>{`● ${test.executionStatus}`}</Text>
          </Box>
          {durationText && <Text dimColor>{durationText}</Text>}
        </Box>

        {/* ── Header: Line 2 — invocation URL ────────────────────── */}
        {targetName ? (
          <Box>
            <Text dimColor>{`Invocation URL: ${gatewayUrlFromArn(test.gatewayArn)}/${targetName}/invocations`}</Text>
          </Box>
        ) : (
          <Box>
            <Text dimColor>Invocation URL: loading...</Text>
          </Box>
        )}

        {/* ── Header: Line 3 — online eval (only for single-config mode) ── */}
        {'onlineEvaluationConfigArn' in test.evaluationConfig && (
          <Box>
            <Text dimColor>{`Online Eval: ${extractId(test.evaluationConfig.onlineEvaluationConfigArn)}`}</Text>
          </Box>
        )}

        {/* ── Description (if present) ────────────────────────── */}
        {test.description && (
          <Box>
            <Text dimColor>{`Description: ${test.description}`}</Text>
          </Box>
        )}

        {/* ── Variants: side-by-side ──────────────────────────── */}
        <Box marginTop={1}>
          <Box flexDirection="column" minWidth={colW} marginRight={2}>
            <Text bold>{'CONTROL (C)'}</Text>
            <Text color="cyan">{`${String(controlVariant?.weight ?? 'N/A')}% traffic`}</Text>
            <Text dimColor>
              {controlVariant?.variantConfiguration.target
                ? `target: ${controlVariant.variantConfiguration.target.name}`
                : `${extractId(controlVariant?.variantConfiguration.configurationBundle?.bundleArn ?? '')} @ ${shortVersion(controlVariant?.variantConfiguration.configurationBundle?.bundleVersion ?? '')}`}
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text bold>{'TREATMENT (T1)'}</Text>
            <Text color="cyan">{`${String(treatmentVariant?.weight ?? 'N/A')}% traffic`}</Text>
            <Text dimColor>
              {treatmentVariant?.variantConfiguration.target
                ? `target: ${treatmentVariant.variantConfiguration.target.name}`
                : `${extractId(treatmentVariant?.variantConfiguration.configurationBundle?.bundleArn ?? '')} @ ${shortVersion(treatmentVariant?.variantConfiguration.configurationBundle?.bundleVersion ?? '')}`}
            </Text>
          </Box>
        </Box>

        {/* ── Evaluation Results ───────────────────────────────── */}
        <Box marginTop={1} flexDirection="column">
          {test.results ? (
            <>
              <Text dimColor>
                {rule(
                  'Results',
                  test.results.analysisTimestamp ? formatTimestamp(test.results.analysisTimestamp) : undefined
                )}
              </Text>
              <Box marginTop={1}>
                <Box minWidth={24}>
                  <Text dimColor>{''}</Text>
                </Box>
                <Box minWidth={12}>
                  <Text dimColor>{'Control'}</Text>
                </Box>
                <Box minWidth={12}>
                  <Text dimColor>{'Treatment'}</Text>
                </Box>
                <Text dimColor>{'Δ'}</Text>
              </Box>
              {test.results.evaluatorMetrics.map((metric, i) => (
                <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
                  <Box>
                    <Box minWidth={24}>
                      <Text bold>{extractId(metric.evaluatorArn)}</Text>
                    </Box>
                    <Box minWidth={12}>
                      <Text>{metric.controlStats.mean.toFixed(4)}</Text>
                    </Box>
                    <Box minWidth={12}>
                      <Text>{metric.variantResults[0]?.mean.toFixed(4) ?? ''}</Text>
                    </Box>
                    {metric.variantResults[0]?.isSignificant ? (
                      <Text color="green">{`+${(metric.variantResults[0]?.percentChange ?? 0).toFixed(2)}% ✓`}</Text>
                    ) : (
                      <Text color="red">{`${(metric.variantResults[0]?.percentChange ?? 0).toFixed(2)}% ✗`}</Text>
                    )}
                  </Box>
                  <Box>
                    <Box minWidth={24}>
                      <Text>{''}</Text>
                    </Box>
                    <Box minWidth={12}>
                      <Text dimColor>{`n=${metric.controlStats.sampleSize}`}</Text>
                    </Box>
                    <Box minWidth={12}>
                      <Text dimColor>{`n=${metric.variantResults[0]?.sampleSize ?? ''}`}</Text>
                    </Box>
                    <Text dimColor>{`p=${metric.variantResults[0]?.pValue?.toFixed(3) ?? 'N/A'}`}</Text>
                  </Box>
                </Box>
              ))}
            </>
          ) : (
            <>
              <Text dimColor>{rule('Results')}</Text>
              <Box marginTop={1}>
                <Text dimColor>No evaluation results yet.</Text>
              </Box>
            </>
          )}
        </Box>

        {/* ── Debug Panel ─────────────────────────────────────── */}
        {debugLoading && (
          <Box marginTop={1}>
            <GradientText text="Running pipeline diagnostics..." />
          </Box>
        )}
        {debugResults && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{rule('Pipeline Debug')}</Text>
            {debugResults.map((check, i) => {
              const icon = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '⚠';
              const color = check.status === 'pass' ? 'green' : check.status === 'fail' ? 'red' : 'yellow';
              return (
                <Box key={i}>
                  <Text color={color}>{`  ${icon} `}</Text>
                  <Text bold>{check.label}</Text>
                  <Text dimColor>{`  ${check.detail}`}</Text>
                </Box>
              );
            })}
          </Box>
        )}

        {/* ── Stop confirmation ────────────────────────────────── */}
        {confirmingStop && (
          <Box marginTop={1}>
            <Text color="yellow" bold>
              {
                'Stop this AB test permanently? All traffic will shift to the control variant. This cannot be undone. (Y/n)'
              }
            </Text>
          </Box>
        )}

        {/* ── Promote confirmation ─────────────────────────────── */}
        {confirmingPromote && (
          <Box marginTop={1}>
            <Text color="green" bold>
              {
                'Promote treatment as winner? This will stop the AB test and update the control endpoint to the treatment version. Run `agentcore deploy` after to apply. (Y/n)'
              }
            </Text>
          </Box>
        )}

        {/* ── Action feedback ──────────────────────────────────── */}
        {actionMessage && !confirmingStop && (
          <Box marginTop={1}>
            <Text color="cyan">{actionMessage}</Text>
          </Box>
        )}
      </Box>
    </Screen>
  );
}
