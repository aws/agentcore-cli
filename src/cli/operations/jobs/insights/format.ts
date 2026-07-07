/** Presentation helpers for insights job CLI output (history table + detail view). */
import { formatJobDate } from '../shared/format';
import type { InsightsJobRecord } from '../shared/types';

export function printInsightsHistory(records: InsightsJobRecord[]): void {
  if (records.length === 0) {
    console.log('No insights jobs found. Run `agentcore run insights` to create one.');
    return;
  }
  console.log(`\n${'Date'.padEnd(22)} ${'Status'.padEnd(22)} ${'Insights'.padEnd(28)} ${'ID'}`);
  console.log('─'.repeat(100));
  for (const r of records) {
    console.log(
      `${formatJobDate(r.createdAt).padEnd(22)} ${r.status.padEnd(22)} ${r.insights.join(', ').padEnd(28)} ${r.id}`
    );
  }
  console.log('');
}

export function printInsightsDetail(record: InsightsJobRecord): void {
  console.log(`\nInsights job: ${record.id}`);
  console.log(`Name: ${record.name}`);
  console.log(`Status: ${record.status}`);
  console.log(`Agent: ${record.agent}`);
  console.log(`Insights: ${record.insights.join(', ')}`);
  if (record.evaluators?.length) {
    console.log(`Evaluators: ${record.evaluators.join(', ')}`);
  }
  console.log(`Started: ${formatJobDate(record.createdAt)}`);
  if (record.completedAt) console.log(`Completed: ${formatJobDate(record.completedAt)}`);

  const fa = record.failureAnalysisResult;
  if (fa?.failureCategories?.length) {
    console.log('\nFailure Analysis:');
    for (const cat of fa.failureCategories) {
      console.log(`\n  Category: ${cat.failureCategoryName ?? 'Unknown'}`);
      if (cat.failureCategoryDescription) {
        console.log(`  Description: ${cat.failureCategoryDescription}`);
      }
      if (cat.categoryGroupName) {
        console.log(`  Group: ${cat.categoryGroupName}`);
      }
      if (cat.rootCauses?.length) {
        for (const rc of cat.rootCauses) {
          console.log(`    Root cause: ${rc.rootCauseCategory ?? 'Unknown'}`);
          if (rc.rootCauseDescription) {
            console.log(`      ${rc.rootCauseDescription}`);
          }
          if (rc.recommendation) {
            console.log(`      Recommendation: ${rc.recommendation}`);
          }
          if (rc.relatedSessions?.length) {
            console.log(`      Sessions: ${rc.relatedSessions.map(s => s.sessionId).join(', ')}`);
          }
        }
      }
    }
  } else {
    const evalResults = record.evaluationResults;
    if (evalResults?.evaluatorSummaries?.length) {
      console.log('\nEvaluation Results:');
      for (const s of evalResults.evaluatorSummaries) {
        const avg = s.statistics?.averageScore;
        console.log(
          `  ${s.evaluatorId}: ${avg != null ? avg.toFixed(2) : 'N/A'}${s.totalFailed ? ` (${s.totalFailed} failed)` : ''}`
        );
      }
    } else {
      console.log('\nResults not yet available.');
    }
  }

  if (record.logFilePath) console.log(`\nLog: ${record.logFilePath}`);
  console.log('');
}
