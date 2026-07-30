/** Presentation helpers for A/B-test job CLI output (history table + detail view). */
import { dnsSuffix } from '../../../aws/partition';
import { formatJobDate } from '../shared/format';
import type { ABTestJobRecord } from '../shared/types';

/** Gateway base URL (no path) from the stored gateway ARN, or undefined if the ARN can't be parsed. */
function gatewayBaseUrl(record: ABTestJobRecord): string | undefined {
  const parts = record.gatewayArn.split(':');
  const region = parts[3];
  const gatewayId = parts[5]?.split('/')[1];
  if (!region || !gatewayId) return undefined;
  return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix(region)}`;
}

/** The gateway target name that uniquely identifies this test's invocation path, if there is exactly one. */
function uniqueTargetName(record: ABTestJobRecord): string | undefined {
  // Target-based: the control variant's target. Config-bundle: the target resolved at create time,
  // set only when exactly one gateway target routed to the runtime.
  return record.mode === 'target-based' ? record.variants[0]?.targetName : record.targetName;
}

/**
 * Derive the complete invocation URL: `https://{gateway}/{target}/invocations`.
 *
 * The path segment must be a gateway TARGET name. Config-bundle records store the target resolved from
 * the runtime at create time (`targetName`); target-based records carry it on the control variant.
 * Returns undefined when no single target is known — either the gateway has none fronting the runtime,
 * or several do (see getInvocationUrlCandidates). Substituting the runtime name here produced URLs that
 * 404'd with "No Target found for Target name: <runtime>" (issue #1854), so it is deliberately not done.
 */
export function getInvocationUrl(record: ABTestJobRecord): string | undefined {
  const baseUrl = gatewayBaseUrl(record);
  const targetName = uniqueTargetName(record);
  return baseUrl && targetName ? `${baseUrl}/${targetName}/invocations` : undefined;
}

/**
 * Candidate invocation URLs when several gateway targets route to the runtime (config-bundle only).
 * Each is a valid path; only the user can say which should receive traffic. Empty when a single URL
 * was resolvable (use getInvocationUrl) or when no target matched.
 */
export function getInvocationUrlCandidates(record: ABTestJobRecord): string[] {
  const baseUrl = gatewayBaseUrl(record);
  if (!baseUrl || !record.targetCandidates?.length) return [];
  return record.targetCandidates.map(t => `${baseUrl}/${t}/invocations`);
}

/** Gateway base URL to show when no invocation path could be determined, so the user can build one. */
export function getGatewayBaseUrl(record: ABTestJobRecord): string | undefined {
  return gatewayBaseUrl(record);
}

/** Names what the caller must append to a gateway base URL to reach a variant. */
export const INVOCATION_PATH_HINT = 'append /<gateway-target>/invocations (see `agentcore status --json`)';

export function printABTestHistory(records: ABTestJobRecord[]): void {
  if (records.length === 0) {
    console.log('No A/B test jobs found. Run `agentcore run ab-test` to create one.');
    return;
  }
  console.log(
    `\n${'Date'.padEnd(22)} ${'Execution'.padEnd(12)} ${'Lifecycle'.padEnd(12)} ${'Name'.padEnd(24)} ${'ID'}`
  );
  console.log('─'.repeat(100));
  for (const r of records) {
    console.log(
      `${formatJobDate(r.createdAt).padEnd(22)} ${r.status.padEnd(12)} ${r.lifecycleStatus.padEnd(12)} ${r.name.padEnd(24)} ${r.id}`
    );
  }
  console.log('');
}

export function printABTestDetail(record: ABTestJobRecord): void {
  console.log(`\nA/B test: ${record.id}`);
  console.log(`Name: ${record.name}`);
  console.log(`Mode: ${record.mode}`);
  console.log(`Execution status: ${record.status}`);
  console.log(`Lifecycle status: ${record.lifecycleStatus}`);
  console.log(`Gateway: ${record.gatewayArn}`);
  console.log(`Gateway filter: ${record.gatewayFilter?.targetPaths?.[0] ?? 'none'}`);
  const invocationUrl = getInvocationUrl(record);
  const candidates = getInvocationUrlCandidates(record);
  if (invocationUrl) {
    console.log(`Invocation URL: ${invocationUrl}`);
  } else if (candidates.length) {
    console.log('Invocation URLs (one per matching gateway target — pick the one to send traffic to):');
    for (const url of candidates) console.log(`  ${url}`);
  } else {
    const baseUrl = getGatewayBaseUrl(record);
    if (baseUrl) {
      console.log(`Gateway URL: ${baseUrl}`);
      console.log(`  → ${INVOCATION_PATH_HINT}`);
    }
  }
  console.log(`Started: ${formatJobDate(record.createdAt)}`);
  if (record.completedAt) console.log(`Stopped: ${formatJobDate(record.completedAt)}`);
  if (record.maxDurationExpiresAt) console.log(`Max duration expires: ${formatJobDate(record.maxDurationExpiresAt)}`);

  console.log('\nVariants:');
  for (const v of record.variants) {
    const detail = v.bundleArn
      ? `bundle ${v.bundleArn} @ ${v.bundleVersion}`
      : v.targetName
        ? `target ${v.targetName}`
        : '(unspecified)';
    console.log(`  ${v.name} (weight ${v.weight}): ${detail}`);
  }

  const metrics = record.results?.evaluatorMetrics;
  if (metrics?.length) {
    console.log('\nResults:');
    for (const m of metrics) {
      console.log(`  ${m.evaluatorArn}`);
      console.log(`    C (n=${m.controlStats.sampleSize}): mean ${m.controlStats.mean.toFixed(3)}`);
      for (const vr of m.variantResults) {
        const change =
          vr.percentChange != null ? ` (${vr.percentChange > 0 ? '+' : ''}${vr.percentChange.toFixed(1)}%)` : '';
        const sig = vr.isSignificant ? ' *significant*' : '';
        console.log(`    ${vr.treatmentName} (n=${vr.sampleSize}): mean ${vr.mean.toFixed(3)}${change}${sig}`);
      }
    }
  } else if (record.failureReason) {
    console.log(`\nFailure: ${record.failureReason}`);
  } else {
    console.log('\nResults not yet available.');
  }
  if (record.logFilePath) console.log(`\nLog: ${record.logFilePath}`);
  console.log('');
}
