/** Presentation helpers for recommendation job CLI output (history table + detail view). */
import { formatJobDate } from '../shared/format';
import type { RecommendationJobRecord } from '../shared/types';

function shortType(type: string): string {
  if (type === 'SYSTEM_PROMPT_RECOMMENDATION') return 'System Prompt';
  if (type === 'TOOL_DESCRIPTION_RECOMMENDATION') return 'Tool Description';
  return type;
}

export function printRecommendationHistory(records: RecommendationJobRecord[]): void {
  if (records.length === 0) {
    console.log('No recommendation jobs found. Run `agentcore run recommendation` to create one.');
    return;
  }
  console.log(`\n${'Date'.padEnd(22)} ${'Status'.padEnd(14)} ${'Type'.padEnd(18)} ${'Agent'.padEnd(18)} ${'ID'}`);
  console.log('─'.repeat(100));
  for (const r of records) {
    console.log(
      `${formatJobDate(r.createdAt).padEnd(22)} ${r.status.padEnd(14)} ${shortType(r.recommendationType).padEnd(18)} ${(r.agent ?? 'unknown').padEnd(18)} ${r.id}`
    );
  }
  console.log('');
}

export function printRecommendationDetail(record: RecommendationJobRecord): void {
  console.log(`\nRecommendation: ${record.id}`);
  console.log(`Status: ${record.status}`);
  console.log(`Agent: ${record.agent}`);
  console.log(`Type: ${shortType(record.recommendationType)}`);
  console.log(`Evaluators: ${record.evaluators.join(', ') || '(none)'}`);
  console.log(`Started: ${formatJobDate(record.createdAt)}`);
  if (record.completedAt) console.log(`Completed: ${formatJobDate(record.completedAt)}`);
  if (record.kmsKeyArn) console.log(`KMS Key: ${record.kmsKeyArn}`);

  const sys = record.result?.systemPromptRecommendationResult;
  const tool = record.result?.toolDescriptionRecommendationResult;
  if (sys?.recommendedSystemPrompt) {
    console.log('\n+++ Recommended System Prompt +++');
    console.log(sys.recommendedSystemPrompt);
    if (sys.explanation) {
      console.log('\n--- Explanation ---');
      console.log(sys.explanation);
    }
  } else if (tool?.tools?.length) {
    for (const t of tool.tools) {
      console.log(`\nTool: ${t.toolName}`);
      console.log(`Recommended: ${t.recommendedToolDescription}`);
      if (t.explanation) {
        console.log(`Explanation: ${t.explanation}`);
      }
    }
  } else if (record.status === 'FAILED') {
    console.log(`\nError: ${record.failureDetail ?? record.statusReasons?.join('; ') ?? 'unknown'}`);
  } else {
    console.log('\nResult not yet available.');
  }
  if (record.syncedVersionId) {
    console.log(`\nNew config bundle version ${record.syncedVersionId} applied to agentcore.json.`);
  }
  if (record.logFilePath) console.log(`\nLog: ${record.logFilePath}`);
  console.log('');
}
