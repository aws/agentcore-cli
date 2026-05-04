import { ConfigIO } from '../../../lib';
import { listABTests, updateABTest } from '../../aws/agentcore-ab-tests';
import { stopBatchEvaluation } from '../../aws/agentcore-batch-evaluation';
import { getErrorMessage } from '../../errors';
import { handlePauseResume } from '../../operations/eval';
import type { OnlineEvalActionOptions } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { getRegion } from '../shared/region-utils';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function registerOnlineEvalSubcommand(parent: Command, action: 'pause' | 'resume') {
  const description =
    action === 'pause'
      ? 'Pause a deployed online eval config. Use --arn to target configs outside the project.'
      : 'Resume a paused online eval config. Use --arn to target configs outside the project.';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('online-eval')
    .description(description)
    .argument('[name]', 'Config name from project (not needed with --arn)')
    .option('--arn <arn>', 'Online eval config ARN — operate without a project directory')
    .option('--region <region>', 'AWS region override (auto-detected from ARN otherwise)')
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, cliOptions: { arn?: string; region?: string; json?: boolean }) => {
      if (!cliOptions.arn && !name) {
        const error = 'Either a config name or --arn is required';
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          render(<Text color="red">{error}</Text>);
        }
        process.exit(1);
      }

      if (!cliOptions.arn) {
        requireProject();
      }

      const options: OnlineEvalActionOptions = {
        name: name ?? '',
        arn: cliOptions.arn,
        region: cliOptions.region,
        json: cliOptions.json,
      };

      try {
        const result = await handlePauseResume(options, action);

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else if (result.success) {
          const displayName = cliOptions.arn ? result.configId : name;
          console.log(`${pastTense} online eval config "${displayName}" (status: ${result.executionStatus})`);
        } else {
          render(<Text color="red">{result.error}</Text>);
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
    });
}

async function resolveABTestId(
  testName: string,
  region: string
): Promise<{ abTestId: string; region: string; error?: string }> {
  let projectName: string | undefined;
  try {
    const configIO = new ConfigIO();
    const deployedState = await configIO.readDeployedState();
    const awsTargets = await configIO.readAWSDeploymentTargets();

    try {
      const projectSpec = await configIO.readProjectSpec();
      projectName = projectSpec.name;
    } catch {
      // Project spec unavailable
    }

    for (const [targetName, target] of Object.entries(deployedState.targets ?? {})) {
      const abTests = target.resources?.abTests;
      if (abTests?.[testName]) {
        const targetConfig = awsTargets.find(t => t.name === targetName);
        const resolvedRegion = targetConfig?.region ?? region;
        return { abTestId: abTests[testName].abTestId, region: resolvedRegion };
      }
    }
  } catch {
    // No deployed state
  }

  try {
    const result = await listABTests({ region, maxResults: 100 });
    // Match against both prefixed name ({projectName}_{testName}) and bare testName (backwards compat)
    const prefixedName = projectName ? `${projectName}_${testName}` : undefined;
    const match =
      result.abTests.find(t => prefixedName != null && t.name === prefixedName) ??
      result.abTests.find(t => t.name === testName);
    if (match) return { abTestId: match.abTestId, region };
  } catch {
    // API call failed
  }

  return { abTestId: '', region, error: `AB test "${testName}" not found in deployed state or API.` };
}

function registerABTestSubcommand(parent: Command, action: 'pause' | 'resume') {
  const executionStatus = action === 'pause' ? 'PAUSED' : 'RUNNING';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('ab-test')
    .description(`[preview] ${action === 'pause' ? 'Pause' : 'Resume'} a deployed A/B test`)
    .argument('<name>', 'AB test name')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);
        const { abTestId, error } = await resolveABTestId(name, region);
        if (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
        }

        const result = await updateABTest({
          region,
          abTestId,
          executionStatus,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`${pastTense} AB test "${name}" (execution: ${result.executionStatus})`);
        }
        process.exit(0);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });
}

export const registerPause = (program: Command) => {
  const pauseCmd = program.command('pause').description(COMMAND_DESCRIPTIONS.pause);
  registerOnlineEvalSubcommand(pauseCmd, 'pause');
  registerABTestSubcommand(pauseCmd, 'pause');
};

export const registerResume = (program: Command) => {
  const resumeCmd = program.command('resume').description(COMMAND_DESCRIPTIONS.resume);
  registerOnlineEvalSubcommand(resumeCmd, 'resume');
  registerABTestSubcommand(resumeCmd, 'resume');
};

export const registerStop = (program: Command) => {
  const stopCmd = program.command('stop').description('Stop resources');

  stopCmd
    .command('ab-test')
    .description('[preview] Stop a deployed A/B test permanently')
    .argument('<name>', 'AB test name')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);
        const { abTestId, error } = await resolveABTestId(name, region);
        if (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
        }

        const result = await updateABTest({
          region,
          abTestId,
          executionStatus: 'STOPPED',
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`Stopped AB test "${name}" (execution: ${result.executionStatus})`);
        }
        process.exit(0);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });

  stopCmd
    .command('batch-evaluation')
    .description('[preview] Stop a running batch evaluation')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to stop')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { id: string; region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);

        const result = await stopBatchEvaluation({
          region,
          batchEvaluationId: cliOptions.id,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`\nBatch evaluation stopped successfully`);
          console.log(`ID: ${result.batchEvaluationId}`);
          console.log(`Status: ${result.status}\n`);
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
    });
};

export const registerPromote = (program: Command) => {
  const promoteCmd = program.command('promote').description('Promote resources');

  promoteCmd
    .command('ab-test')
    .description('Promote the winning treatment of an A/B test')
    .argument('<name>', 'AB test name')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);
        const { abTestId, error } = await resolveABTestId(name, region);
        if (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
        }

        // Stop the AB test
        const result = await updateABTest({
          region,
          abTestId,
          executionStatus: 'STOPPED',
        });

        // Apply promotion to agentcore.json
        const { promoteABTestConfig } = await import('../../operations/ab-test/promote');
        let promoted = false;
        let mode: string | undefined;
        let promotionDetail = '';
        try {
          const promoResult = await promoteABTestConfig(abTestId, name);
          promoted = promoResult.promoted;
          mode = promoResult.mode;
          promotionDetail = promoResult.promotionDetail;
        } catch {
          // Config read/write failed
        }

        if (cliOptions.json) {
          console.log(
            JSON.stringify({
              success: true,
              ...result,
              ...(mode && { mode }),
              promoted,
              ...(promotionDetail && { promotionDetail }),
            })
          );
        } else {
          console.log(`AB test "${name}" stopped.`);
          if (promoted) {
            console.log(`\n${promotionDetail}`);
            console.log(`\nRun: agentcore deploy`);
          }
        }
        process.exit(0);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });
};
