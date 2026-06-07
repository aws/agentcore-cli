import { ConfigIO } from '../../../lib';
import { createDefaultProjectSpec } from '../../project';
import { HarnessPrimitive } from '../HarnessPrimitive';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('HarnessPrimitive', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('resolves create-flow Dockerfile paths from the command working directory', async () => {
    const commandCwd = join(tmpdir(), `harness-dockerfile-${randomUUID()}`);
    tempDirs.push(commandCwd);
    const projectRoot = join(commandCwd, 'HarnessProject');
    const configBaseDir = join(projectRoot, 'agentcore');
    await mkdir(projectRoot, { recursive: true });

    const configIO = new ConfigIO({ baseDir: configBaseDir });
    await configIO.initializeBaseDir();
    await configIO.writeAWSDeploymentTargets([]);
    await configIO.writeDeployedState({ targets: {} });
    await configIO.writeProjectSpec(createDefaultProjectSpec('HarnessProject'));

    await writeFile(join(commandCwd, 'Dockerfile.custom'), 'FROM public.ecr.aws/docker/library/python:3.12\n');

    const result = await new HarnessPrimitive().add({
      name: 'MyHarness',
      modelProvider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      skipMemory: true,
      dockerfilePath: './Dockerfile.custom',
      dockerfileBaseDir: commandCwd,
      configBaseDir,
    });

    expect(result.success).toBe(true);
    const harnessDir = join(projectRoot, 'app', 'MyHarness');
    await expect(readFile(join(harnessDir, 'Dockerfile.custom'), 'utf-8')).resolves.toContain('python:3.12');

    const harnessSpec = JSON.parse(await readFile(join(harnessDir, 'harness.json'), 'utf-8'));
    expect(harnessSpec.dockerfile).toBe('Dockerfile.custom');
  });
});
