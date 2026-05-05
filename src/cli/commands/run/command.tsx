import { serializeResult } from '../../../lib';
import type { RecommendationType } from '../../aws/agentcore-recommendation';
import { getErrorMessage } from '../../errors';
import { handleRunEval } from '../../operations/eval';
import type { RunEvalOptions } from '../../operations/eval';
import { saveBatchEvalRun } from '../../operations/eval/batch-eval-storage';
import { runBatchEvaluationCommand } from '../../operations/eval/run-batch-evaluation';
import type {
  BatchEvaluationResult,
  RunBatchEvaluationCommandResult,
} from '../../operations/eval/run-batch-evaluation';
import {
  applyRecommendationToBundle,
  runRecommendationCommand,
  saveRecommendationRun,
} from '../../operations/recommendation';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

const RECOMMENDATION_TYPE_MAP: Record<string, RecommendationType> = {
  'system-prompt': 'SYSTEM_PROMPT_RECOMMENDATION',
  'tool-description': 'TOOL_DESCRIPTION_RECOMMENDATION',
};

function formatRunOutput(result: Awaited<ReturnType<typeof handleRunEval>>): void {
  if (!result.success) return;

  const { run } = result;
  const date = new Date(run.timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  console.log(`\nAgent: ${run.agent} | ${date} | Sessions: ${run.sessionCount} | Lookback: ${run.lookbackDays}d`);

  if (run.referenceInputs) {
    const parts: string[] = [];
    if (run.referenceInputs.assertions?.length) {
      parts.push(`${run.referenceInputs.assertions.length} assertion(s)`);
    }
    if (run.referenceInputs.expectedResponse) {
      parts.push('expected response');
    }
    if (run.referenceInputs.expectedTrajectory?.length) {
      parts.push(`${run.referenceInputs.expectedTrajectory.length} trajectory step(s)`);
    }
    if (parts.length > 0) {
      console.log(`Reference inputs: ${parts.join(', ')}`);
    }
  }
  console.log('');

  for (const r of run.results) {
    const score = r.aggregateScore.toFixed(2);
    const errors = r.sessionScores.filter((s: { errorMessage?: string }) => s.errorMessage).length;
    const errorSuffix = errors > 0 ? ` (${errors} errors)` : '';
    console.log(`  ${r.evaluator}: ${score}${errorSuffix}`);
  }

  if (result.filePath) {
    console.log(`\nResults saved to: ${result.filePath}`);
  }
}

export const registerRun = (program: Command) => {
  const runCmd = program.command('run').description(COMMAND_DESCRIPTIONS.run);

  runCmd
    .command('eval')
    .description(
      'Run on-demand evaluation of runtime traces. Use --runtime-arn to evaluate runtimes outside the project.'
    )
    .option('-r, --runtime <name>', 'Runtime name from project config')
    .option('--runtime-arn <arn>', 'Runtime ARN — run outside a project directory')
    .option('-e, --evaluator <names...>', 'Evaluator name(s) — project evaluators or Builtin.* IDs')
    .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) — use with --runtime-arn for standalone mode')
    .option('--region <region>', 'AWS region (required with --runtime-arn, auto-detected otherwise)')
    .option('-s, --session-id <id>', 'Evaluate a specific session only')
    .option('-t, --trace-id <id>', 'Evaluate a specific trace only')
    .option(
      '--endpoint <name>',
      'Runtime endpoint name (e.g. PROMPT_V1). Defaults to AGENTCORE_RUNTIME_ENDPOINT env var, then DEFAULT'
    )
    .option('--days <days>', 'Lookback window in days', '7')
    .option('-A, --assertion <text...>', 'Ground truth assertion the agent response must satisfy (repeatable)')
    .option('--expected-trajectory <names>', 'Ground truth: expected tool call names in order (comma-separated)')
    .option('--expected-response <text>', 'Ground truth: expected agent response text to compare against')
    .option('--output <path>', 'Custom output file path for results')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        runtime?: string;
        runtimeArn?: string;
        evaluator?: string[];
        evaluatorArn?: string[];
        region?: string;
        sessionId?: string;
        traceId?: string;
        endpoint?: string;
        assertion?: string[];
        expectedTrajectory?: string;
        expectedResponse?: string;
        days: string;
        output?: string;
        json?: boolean;
      }) => {
        const isArnMode = !!(cliOptions.runtimeArn && cliOptions.evaluatorArn);
        if (!isArnMode) {
          requireProject();
        }

        if (!cliOptions.evaluator && !cliOptions.evaluatorArn) {
          const error = 'At least one --evaluator or --evaluator-arn is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const options: RunEvalOptions = {
          agent: cliOptions.runtime,
          agentArn: cliOptions.runtimeArn,
          evaluator: cliOptions.evaluator ?? [],
          evaluatorArn: cliOptions.evaluatorArn,
          region: cliOptions.region,
          sessionId: cliOptions.sessionId,
          traceId: cliOptions.traceId,
          endpoint: cliOptions.endpoint,
          assertions: cliOptions.assertion,
          expectedTrajectory: cliOptions.expectedTrajectory
            ? cliOptions.expectedTrajectory.split(',').map(s => s.trim())
            : undefined,
          expectedResponse: cliOptions.expectedResponse,
          days: parseInt(cliOptions.days, 10),
          output: cliOptions.output,
          json: cliOptions.json,
        };

        try {
          const result = await handleRunEval(options);

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else if (result.success) {
            formatRunOutput(result);
          } else {
            formatRunOutput(result);
            render(<Text color="red">{result.error.message}</Text>);
          }

          process.exit(result.success ? 0 : 1);
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

  runCmd
    .command('batch-evaluation')
    .description('[preview] Run evaluators in batch across all agent sessions in CloudWatch')
    .requiredOption('-r, --runtime <name>', 'Runtime name from project config')
    .requiredOption('-e, --evaluator <ids...>', 'Evaluator name(s) — Builtin.* IDs')
    .option('-n, --name <name>', 'Name for the batch evaluation (auto-generated if omitted)')
    .option('-d, --lookback-days <days>', 'Lookback window in days (filters sessions by time range)')
    .option('-s, --session-ids <ids...>', 'Specific session IDs to evaluate')
    .option(
      '-g, --ground-truth <path>',
      'JSON file with session metadata and ground truth (assertions, expected trajectory, turns)'
    )
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        runtime: string;
        evaluator: string[];
        name?: string;
        lookbackDays?: string;
        sessionIds?: string[];
        groundTruth?: string;
        region?: string;
        json?: boolean;
      }) => {
        requireProject();

        try {
          // Parse ground truth file if provided
          let sessionMetadata: import('../../aws/agentcore-batch-evaluation').SessionMetadataEntry[] | undefined;
          if (cliOptions.groundTruth) {
            const { readFileSync } = await import('node:fs');
            const gtContent = readFileSync(cliOptions.groundTruth, 'utf-8');
            const gtData = JSON.parse(gtContent) as Record<string, unknown>;
            // Accept either a raw array or an object with a sessionMetadata key
            sessionMetadata = Array.isArray(gtData)
              ? (gtData as import('../../aws/agentcore-batch-evaluation').SessionMetadataEntry[])
              : (gtData.sessionMetadata as import('../../aws/agentcore-batch-evaluation').SessionMetadataEntry[]);
            if (!Array.isArray(sessionMetadata)) {
              throw new Error(
                'Ground truth file must be a JSON array of session metadata entries, or an object with a "sessionMetadata" key'
              );
            }
          }

          const lookbackDays = cliOptions.lookbackDays ? parseInt(cliOptions.lookbackDays, 10) : undefined;
          const result = await runBatchEvaluationCommand({
            agent: cliOptions.runtime,
            evaluators: cliOptions.evaluator,
            name: cliOptions.name,
            region: cliOptions.region,
            sessionIds: cliOptions.sessionIds,
            lookbackDays: lookbackDays && !isNaN(lookbackDays) ? lookbackDays : undefined,
            sessionMetadata,
            onProgress: cliOptions.json
              ? undefined
              : (_status, message) => {
                  console.log(message);
                },
          });

          // Save results locally
          if (result.success) {
            try {
              const filePath = saveBatchEvalRun(result);
              if (!cliOptions.json) {
                console.log(`\nResults saved to: ${filePath}`);
              }
            } catch {
              // Non-fatal — skip saving
            }
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else if (result.success) {
            formatBatchEvalOutput(result);
          } else {
            render(<Text color="red">{result.error.message}</Text>);
            if (result.logFilePath) {
              console.error(`\nLog: ${result.logFilePath}`);
            }
          }

          process.exit(result.success ? 0 : 1);
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

  runCmd
    .command('recommendation')
    .description('[preview] Optimize a system prompt or tool descriptions using agent traces as signal')
    .option('-t, --type <type>', 'What to optimize: system-prompt or tool-description (default: system-prompt)')
    .option('-r, --runtime <name>', 'Runtime name from project config')
    .option('-e, --evaluator <name>', 'Evaluator name — required for system-prompt (exactly one)')
    .option('--prompt-file <path>', 'Load the current system prompt from a file')
    .option('--inline <content>', 'Provide the current system prompt or tool descriptions inline')
    .option('--bundle-name <name>', 'Read current content from a deployed config bundle')
    .option('--bundle-version <version>', 'Config bundle version (used with --bundle-name)')
    .option(
      '--system-prompt-json-path <path>',
      'Field name under "configuration" in the bundle (e.g. "systemPrompt"). The CLI resolves it to the full path automatically. Do not use bracket notation — use dot notation only.'
    )
    .option(
      '--tool-desc-json-path <pair...>',
      'Tool name:field pairs for tool descriptions in a config bundle (e.g. --tool-desc-json-path "search:searchDesc"). The CLI resolves each to the full path automatically.'
    )
    .option(
      '--tools <pair...>',
      'Tool name:description pairs (repeatable, e.g. --tools "search:Searches the web" --tools "calc:Does math")'
    )
    .option('--spans-file <path>', 'JSON file with OTEL session spans (use instead of CloudWatch traces)')
    .option('--lookback <days>', 'How far back to search for traces in CloudWatch (days)', '7')
    .option('-s, --session-id <ids...>', 'Limit trace collection to specific session IDs')
    .option('-n, --run <name>', 'Run name prefix for the recommendation')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        type?: string;
        runtime?: string;
        evaluator?: string;
        promptFile?: string;
        inline?: string;
        bundleName?: string;
        bundleVersion?: string;
        systemPromptJsonPath?: string;
        toolDescJsonPath?: string[];
        tools?: string[];
        spansFile?: string;
        lookback: string;
        sessionId?: string[];
        run?: string;
        region?: string;
        json?: boolean;
      }) => {
        requireProject();

        const typeKey = cliOptions.type ?? 'system-prompt';
        const recType = RECOMMENDATION_TYPE_MAP[typeKey];
        if (!recType) {
          const error = `Invalid --type "${typeKey}". Must be one of: ${Object.keys(RECOMMENDATION_TYPE_MAP).join(', ')}`;
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const agent = cliOptions.runtime;
        const evaluator = cliOptions.evaluator;

        if (!agent) {
          const error = '--runtime is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        // Evaluator is required for system-prompt recs, optional for tool-description
        if (recType === 'SYSTEM_PROMPT_RECOMMENDATION' && !evaluator) {
          const error = '--evaluator is required for system-prompt recommendations';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        try {
          const inputSource = cliOptions.promptFile
            ? ('file' as const)
            : cliOptions.inline
              ? ('inline' as const)
              : cliOptions.bundleName
                ? ('config-bundle' as const)
                : ('inline' as const);

          const traceSource = cliOptions.spansFile
            ? ('spans-file' as const)
            : cliOptions.sessionId
              ? ('sessions' as const)
              : ('cloudwatch' as const);

          // Parse --tool-desc-json-path pairs ("toolName:$.json.path") into structured format
          const toolDescJsonPaths = cliOptions.toolDescJsonPath
            ?.map(pair => {
              const colonIdx = pair.indexOf(':');
              if (colonIdx <= 0) return undefined;
              return {
                toolName: pair.slice(0, colonIdx),
                toolDescriptionJsonPath: pair.slice(colonIdx + 1),
              };
            })
            .filter((p): p is { toolName: string; toolDescriptionJsonPath: string } => p !== undefined);

          const result = await runRecommendationCommand({
            type: recType,
            agent,
            evaluators: evaluator ? [evaluator] : [],
            promptFile: cliOptions.promptFile,
            inlineContent: cliOptions.inline,
            bundleName: cliOptions.bundleName,
            bundleVersion: cliOptions.bundleVersion,
            systemPromptJsonPath: cliOptions.systemPromptJsonPath,
            toolDescJsonPaths: toolDescJsonPaths?.length ? toolDescJsonPaths : undefined,
            tools: cliOptions.tools,
            lookbackDays: parseInt(cliOptions.lookback, 10),
            sessionIds: cliOptions.sessionId,
            spansFile: cliOptions.spansFile,
            recommendationName: cliOptions.run,
            region: cliOptions.region,
            inputSource,
            traceSource,
            onProgress: cliOptions.json
              ? undefined
              : (_status, message) => {
                  console.log(message);
                },
          });

          if (!result.success) {
            if (cliOptions.json) {
              console.log(JSON.stringify(serializeResult(result)));
            } else {
              render(<Text color="red">{result.error.message}</Text>);
              if (result.logFilePath) {
                console.error(`\nLog: ${result.logFilePath}`);
              }
            }
            process.exit(1);
          }

          // Save results locally
          let savedFilePath: string | undefined;
          try {
            if (result.recommendationId) {
              savedFilePath = saveRecommendationRun(
                result.recommendationId,
                result,
                recType,
                agent,
                evaluator ? [evaluator] : []
              );
            }
          } catch {
            // Non-fatal — skip saving
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            console.log(`\nRecommendation ID: ${result.recommendationId}`);

            if (result.result) {
              const sysResult = result.result.systemPromptRecommendationResult;
              const toolResult = result.result.toolDescriptionRecommendationResult;

              if (sysResult) {
                if (sysResult.recommendedSystemPrompt) {
                  console.log('\n+++ Recommended System Prompt +++');
                  console.log(sysResult.recommendedSystemPrompt);
                }
              } else if (toolResult?.tools) {
                for (const tool of toolResult.tools) {
                  console.log(`\nTool: ${tool.toolName}`);
                  console.log(`Recommended: ${tool.recommendedToolDescription}`);
                }
              }
            }

            if (savedFilePath) {
              console.log(`\nResults saved to: ${savedFilePath}`);
            }

            // Sync local config bundle after server-side recommendation apply
            if (inputSource === 'config-bundle' && cliOptions.bundleName && result.result && result.region) {
              try {
                const applyResult = await applyRecommendationToBundle({
                  bundleName: cliOptions.bundleName,
                  result: result.result,
                  region: result.region,
                });
                if (applyResult.success) {
                  console.log(
                    `\nA new config bundle version (${applyResult.newVersionId}) was created with the recommended changes.`
                  );
                  console.log(`Local config for "${cliOptions.bundleName}" has been updated to match.`);
                } else {
                  console.log(`\nCould not sync config bundle: ${applyResult.error.message}`);
                }
              } catch {
                // Non-fatal — user can manually sync
              }
            }
            console.log('');
          }

          process.exit(0);
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
};

function formatBatchEvalOutput(result: RunBatchEvaluationCommandResult): void {
  console.log(`\nBatch Evaluation: ${result.name ?? result.batchEvaluationId}`);
  console.log(`ID: ${result.batchEvaluationId}`);
  console.log(`Status: ${result.status}`);

  // Show session stats from API if available
  const evalResults = result.evaluationResults;
  if (evalResults) {
    const parts: string[] = [];
    if (evalResults.totalNumberOfSessions != null) parts.push(`${evalResults.totalNumberOfSessions} sessions`);
    if (evalResults.numberOfSessionsCompleted != null) parts.push(`${evalResults.numberOfSessionsCompleted} completed`);
    if (evalResults.numberOfSessionsFailed) parts.push(`${evalResults.numberOfSessionsFailed} failed`);
    if (parts.length > 0) console.log(`Sessions: ${parts.join(', ')}`);
  }

  console.log('');

  // Prefer API evaluatorSummaries over local computation
  const summaries = evalResults?.evaluatorSummaries;
  if (summaries && summaries.length > 0) {
    for (const s of summaries) {
      const avg = s.statistics?.averageScore;
      const avgStr = avg != null ? avg.toFixed(2) : 'N/A';
      const failSuffix = s.totalFailed ? ` (${s.totalFailed} failed)` : '';
      const evalCount = s.totalEvaluated != null ? ` [${s.totalEvaluated} evaluated]` : '';
      console.log(`  ${s.evaluatorId}: ${avgStr} avg${failSuffix}${evalCount}`);
    }
  } else if (result.results.length > 0) {
    // Fall back to local computation from CloudWatch results
    const byEvaluator = new Map<string, BatchEvaluationResult[]>();
    for (const r of result.results) {
      const group = byEvaluator.get(r.evaluatorId) ?? [];
      group.push(r);
      byEvaluator.set(r.evaluatorId, group);
    }

    for (const [evalId, evalGroup] of byEvaluator) {
      const scores = evalGroup.filter(r => !r.error).map(r => r.score!);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const errors = evalGroup.filter(r => r.error).length;
      const errorSuffix = errors > 0 ? ` (${errors} errors)` : '';

      console.log(`  ${evalId}: ${avg.toFixed(2)} avg${errorSuffix}`);

      for (const r of evalGroup) {
        if (r.error) {
          console.log(`    ERROR: ${r.error.slice(0, 80)}`);
        } else {
          const labelStr = r.label ? ` (${r.label})` : '';
          console.log(`    ${r.score?.toFixed(2)}${labelStr}`);
        }
      }
    }
  } else {
    console.log('  No evaluation results found.');
  }

  console.log('');
}
