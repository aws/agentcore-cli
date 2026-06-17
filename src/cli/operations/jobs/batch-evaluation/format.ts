/** Presentation helpers for batch-evaluation job CLI output (history table + detail view). */
import { formatJobDate } from '../shared/format';
import type { BatchEvaluationJobRecord } from '../shared/types';

export function printBatchEvaluationHistory(records: BatchEvaluationJobRecord[]): void {
  if (records.length === 0) {
    console.log('No batch evaluation jobs found. Run `agentcore run batch-evaluation` to create one.');
    return;
  }
  console.log(`\n${'Date'.padEnd(22)} ${'Status'.padEnd(22)} ${'Evaluators'.padEnd(28)} ${'ID'}`);
  console.log('─'.repeat(100));
  for (const r of records) {
    console.log(
      `${formatJobDate(r.createdAt).padEnd(22)} ${r.status.padEnd(22)} ${r.evaluators.join(', ').padEnd(28)} ${r.id}`
    );
  }
  console.log('');
}

export function printBatchEvaluationDetail(record: BatchEvaluationJobRecord): void {
  console.log(`\nBatch evaluation: ${record.id}`);
  console.log(`Name: ${record.name}`);
  console.log(`Status: ${record.status}`);
  console.log(`Agent: ${record.agent}`);
  console.log(`Evaluators: ${record.evaluators.join(', ')}`);
  console.log(`Started: ${formatJobDate(record.createdAt)}`);
  if (record.completedAt) console.log(`Completed: ${formatJobDate(record.completedAt)}`);
  if (record.source) console.log(`Source: ${record.source}`);

  const summaries = record.evaluationResults?.evaluatorSummaries;
  if (summaries?.length) {
    console.log('\nResults:');
    for (const s of summaries) {
      const avg = s.statistics?.averageScore;
      console.log(
        `  ${s.evaluatorId}: ${avg != null ? avg.toFixed(2) : 'N/A'}${s.totalFailed ? ` (${s.totalFailed} failed)` : ''}`
      );
    }
  } else if (record.results?.length) {
    console.log('\nResults:');
    for (const r of record.results) {
      console.log(`  ${r.evaluatorId}: ${r.score != null ? r.score.toFixed(2) : (r.label ?? 'N/A')}`);
    }
  } else {
    console.log('\nResults not yet available.');
  }
  if (record.logFilePath) console.log(`\nLog: ${record.logFilePath}`);
  console.log('');
}
