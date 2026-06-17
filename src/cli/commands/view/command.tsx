import { ConfigIO, JobNotFoundError, serializeResult } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import type { ABTestJobRecord, JobType } from '../../operations/jobs';
import { getInvocationUrl, printABTestDetail, printABTestHistory } from '../../operations/jobs/ab-test/format';
import { printBatchEvaluationDetail, printBatchEvaluationHistory } from '../../operations/jobs/batch-evaluation/format';
import { printInsightsDetail, printInsightsHistory } from '../../operations/jobs/insights/format';
import { printRecommendationDetail, printRecommendationHistory } from '../../operations/jobs/recommendation/format';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

const TYPE_META: Record<
  JobType,
  {
    label: string;
    jsonKey: string;
    printHistory: (records: unknown[]) => void;
    printDetail: (record: unknown) => void;
  }
> = {
  recommendation: {
    label: 'recommendation',
    jsonKey: 'recommendations',
    printHistory: printRecommendationHistory as (r: unknown[]) => void,
    printDetail: printRecommendationDetail as (r: unknown) => void,
  },
  'batch-evaluation': {
    label: 'batch evaluation',
    jsonKey: 'batchEvaluations',
    printHistory: printBatchEvaluationHistory as (r: unknown[]) => void,
    printDetail: printBatchEvaluationDetail as (r: unknown) => void,
  },
  'ab-test': {
    label: 'A/B test',
    jsonKey: 'abTests',
    printHistory: printABTestHistory as (r: unknown[]) => void,
    printDetail: printABTestDetail as (r: unknown) => void,
  },
  insights: {
    label: 'insights',
    jsonKey: 'insights',
    printHistory: printInsightsHistory as (r: unknown[]) => void,
    printDetail: printInsightsDetail as (r: unknown) => void,
  },
};

function registerViewSubcommand(viewCmd: Command, type: JobType) {
  const meta = TYPE_META[type];

  viewCmd
    .command(type)
    .description(`View ${meta.label} jobs`)
    .argument('[id]', `${meta.label} job ID`)
    .option('--json', 'Output as JSON (non-interactive)')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .action((id: string | undefined, cliOptions: { json?: boolean; region?: string }) => {
      requireProject();

      if (id) {
        // Detail for one job
        if (cliOptions.json) {
          return runCliCommand('job.get', true, async () => {
            const engine = createJobEngine(new ConfigIO());
            const record = await engine.get(type, id);
            if (!record) {
              throw new JobNotFoundError(`${meta.label} "${id}" not found.`);
            }
            const extra =
              type === 'ab-test' ? { invocationUrl: getInvocationUrl(record as unknown as ABTestJobRecord) } : {};
            console.log(JSON.stringify(serializeResult({ success: true, ...record, ...extra })));
            return { job_type: type };
          });
        }
        // Interactive detail — launch TUI
        return launchTuiDetail(type, id);
      }

      // List all jobs of this type
      if (cliOptions.json) {
        return runCliCommand('job.history', true, async () => {
          const engine = createJobEngine(new ConfigIO());
          const records = await engine.list({ type });
          console.log(
            JSON.stringify({
              success: true,
              [meta.jsonKey]: records,
            })
          );
          return { job_type: type };
        });
      }
      // Interactive list — launch TUI
      return launchTuiList(type);
    });
}

async function launchTuiList(type: JobType): Promise<never> {
  const [{ render }, { default: React }] = await Promise.all([import('ink'), import('react')]);

  if (type === 'ab-test') {
    const { ABTestJobsHistoryScreen } = await import('../../tui/screens/run-ab-test');
    render(React.createElement(ABTestJobsHistoryScreen, { onExit: () => process.exit(0) }));
  } else if (type === 'batch-evaluation') {
    const { BatchEvalHistoryScreen } = await import('../../tui/screens/run-eval');
    render(React.createElement(BatchEvalHistoryScreen, { onExit: () => process.exit(0) }));
  } else if (type === 'insights') {
    const { InsightsJobsScreen } = await import('../../tui/screens/insights-jobs');
    render(React.createElement(InsightsJobsScreen, { onExit: () => process.exit(0) }));
  } else {
    const { RecommendationHistoryScreen } = await import('../../tui/screens/recommendation');
    render(React.createElement(RecommendationHistoryScreen, { onExit: () => process.exit(0) }));
  }
  return new Promise(() => undefined);
}

async function launchTuiDetail(type: JobType, id: string): Promise<never> {
  const [{ render }, { default: React }] = await Promise.all([import('ink'), import('react')]);
  const { JobDetailScreen } = await import('./JobDetailScreen');
  render(React.createElement(JobDetailScreen, { type, id, onExit: () => process.exit(0) }));
  return new Promise(() => undefined);
}

export const registerView = (program: Command) => {
  const viewCmd = program.command('view').description('View job history and details');
  registerViewSubcommand(viewCmd, 'recommendation');
  registerViewSubcommand(viewCmd, 'batch-evaluation');
  registerViewSubcommand(viewCmd, 'ab-test');
  registerViewSubcommand(viewCmd, 'insights');
};
