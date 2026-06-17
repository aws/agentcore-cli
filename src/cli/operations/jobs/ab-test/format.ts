/** Presentation helpers for A/B-test job CLI output (history table + detail view). */
import { dnsSuffix } from '../../../aws/partition';
import { formatJobDate } from '../shared/format';
import type { ABTestJobRecord } from '../shared/types';

/**
 * Derive the gateway invocation URL from the stored gateway ARN.
 * Target-based: `https://{gateway}/{control-target-name}/invocations`.
 * Config-bundle: `https://{gateway}/{agent-name}/invocations`.
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
  return record.agent ? `${baseUrl}/${record.agent}/invocations` : undefined;
}

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
  if (invocationUrl) console.log(`Invocation URL: ${invocationUrl}`);
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
