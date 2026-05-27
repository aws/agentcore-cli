import { ConfigIO } from '../../../lib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Computes a hash of the project configuration relevant to deploy.
 * Includes agentcore.json, all harness.json files, system-prompt.md files,
 * and aws-targets.json.
 *
 * Only used for harness-only projects — runtime projects always need full
 * deploy since source code changes aren't tracked here.
 */
export async function computeProjectDeployHash(configIO: ConfigIO): Promise<string> {
  const hash = createHash('sha256');

  const projectSpec = await configIO.readProjectSpec();
  hash.update(JSON.stringify(projectSpec));

  const configRoot = configIO.getConfigRoot();
  const projectRoot = dirname(configRoot);

  for (const harness of projectSpec.harnesses ?? []) {
    const harnessDir = join(projectRoot, harness.path);
    try {
      const harnessJson = await readFile(join(harnessDir, 'harness.json'), 'utf-8');
      hash.update(harnessJson);
    } catch {
      // harness.json missing — hash will differ from last deploy
    }
    try {
      const prompt = await readFile(join(harnessDir, 'system-prompt.md'), 'utf-8');
      hash.update(prompt);
    } catch {
      // no system prompt
    }
  }

  const awsTargets = await configIO.readAWSDeploymentTargets();
  hash.update(JSON.stringify(awsTargets));

  return hash.digest('hex').slice(0, 16);
}

/**
 * Checks if the project has changed since the last deploy.
 * Returns true if deploy can be skipped.
 *
 * Only applies to harness-only projects. Projects with runtimes always
 * need full deploy since source code changes aren't tracked by hash.
 */
export async function canSkipDeploy(configIO: ConfigIO): Promise<boolean> {
  try {
    const projectSpec = await configIO.readProjectSpec();

    if (projectSpec.runtimes.length > 0) {
      return false;
    }

    const currentHash = await computeProjectDeployHash(configIO);
    const deployedState = await configIO.readDeployedState();
    const targetNames = Object.keys(deployedState.targets);
    if (targetNames.length === 0) return false;

    for (const targetName of targetNames) {
      const targetState = deployedState.targets[targetName];
      const storedHash = targetState?.resources?.deployHash;
      if (storedHash !== currentHash) return false;
    }

    return true;
  } catch {
    return false;
  }
}
