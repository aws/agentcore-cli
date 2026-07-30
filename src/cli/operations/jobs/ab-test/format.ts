/** Presentation helpers for A/B-test job CLI output (history table + detail view). */
import { dnsSuffix } from '../../../aws/partition';
import { formatJobDate } from '../shared/format';
import type { ABTestJobRecord } from '../shared/types';

/**
 * Derive the URL to send test traffic to, from the stored gateway ARN.
 *
 * Target-based: a full invocation URL, `https://{gateway}/{control-target-name}/invocations`.
 *
 * Config-bundle: the gateway base URL only. These tests attach to the whole gateway — the variants
 * are configuration bundles, and the service splits traffic with a gateway rule — so the path segment
 * is whichever gateway target the caller invokes, which the CLI cannot know. The path segment must be
 * a gateway TARGET name; substituting the runtime name (`record.agent`) produced URLs that failed with
 * "No Target found for Target name: <runtime>" whenever a target was not named identically to its
 * runtime (issue #1854). Callers append the target path themselves.
 */
export function getInvocationUrl(record: ABTestJobRecord): string | undefined {
  const parts = record.gatewayArn.split(':');
  const region = parts[3];
  const gatewayId = parts[5]?.split('/')[1];
  if (!region || !gatewayId) return undefined;
  const baseUrl = `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix(region)}`;
  if (record.mode === 'target-based') {
    const targetName = record.variants[0]?.targetName;
    return targetName ? `${baseUrl}/${targetName}/invocations` : undefined;
  }
  return baseUrl;
}

/** True when `getInvocationUrl` yields a gateway base URL that still needs a target path appended. */
export function isGatewayBaseUrl(record: ABTestJobRecord): boolean {
  return record.mode !== 'target-based';
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
  if (invocationUrl) {
    if (isGatewayBaseUrl(record)) {
      console.log(`Gateway URL: ${invocationUrl}`);
      console.log(`  → ${INVOCATION_PATH_HINT}`);
    } else {
      console.log(`Invocation URL: ${invocationUrl}`);
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
