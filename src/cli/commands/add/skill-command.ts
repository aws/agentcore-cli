import { findConfigRoot } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { isGatedFeaturesEnabled } from '../../feature-flags';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { SkillSourceType, standardize } from '../../telemetry/schemas/common-shapes.js';
import { handleAddSkill } from './skill-action';
import { Option } from '@commander-js/extra-typings';
import type { Command } from '@commander-js/extra-typings';

const awsSkillsOption = new Option(
  '--aws-skills [paths]',
  'Add built-in AWS skills (comma-separated paths, or omit for all)'
);

export function registerAddSkill(addCmd: Command): void {
  addCmd
    .command('skill')
    .description('Add a skill to a harness')
    .requiredOption('--harness <name>', 'Target harness name')
    .option('--path <path>', 'Path to an installed skill in the environment')
    .option('--s3 <uri>', 'S3 URI (s3://bucket/path)')
    .option('--git <url>', 'HTTPS git repository URL')
    .option('--git-path <path>', 'Subdirectory within the git repo (for --git)')
    .option('--credential <name>', 'Name of an API key credential in the project (for git auth)')
    .option('--username <name>', 'Username for git auth (for --git)')
    .addOption(isGatedFeaturesEnabled() ? awsSkillsOption : awsSkillsOption.hideHelp())
    .option('--json', 'Output as JSON')
    .action(async cliOptions => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }

      try {
        const sourceType = cliOptions.awsSkills ? 'aws_skills' : cliOptions.git ? 'git' : cliOptions.s3 ? 's3' : 'path';
        const result = await withCommandRunTelemetry(
          'add.skill',
          { skill_source_type: standardize(SkillSourceType, sourceType) },
          () =>
            handleAddSkill({
              harness: cliOptions.harness,
              path: cliOptions.path,
              s3: cliOptions.s3,
              git: cliOptions.git,
              gitPath: cliOptions.gitPath,
              credentialName: cliOptions.credential,
              username: cliOptions.username,
              awsSkills: cliOptions.awsSkills,
            })
        );

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: result.error.message }));
          } else {
            console.error(result.error.message);
          }
          process.exit(1);
        }

        if (cliOptions.json) {
          console.log(
            JSON.stringify({ success: true, harnessName: result.harnessName, skillSource: result.skillSource })
          );
        } else {
          console.log(`Added skill '${result.skillSource}' to harness '${result.harnessName}'.`);
          console.log(`Run 'agentcore deploy' to apply changes.`);
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(getErrorMessage(error));
        }
        process.exit(1);
      }
    });
}
