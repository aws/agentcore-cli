import { ConfigIO } from '../../../../lib';
import { AgentCoreProjectSpecSchema, HarnessSpecSchema } from '../../../../schema';
import { handleExportHarness } from '../harness-action';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/utils/subprocess', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSubprocessCaptureSync: vi.fn(() => ({ stdout: '', stderr: '', code: 0, signal: null })),
}));

describe('exported container Dockerfiles', () => {
  const originalCwd = process.cwd();
  let projectRoot: string;
  let configIO: ConfigIO;

  beforeEach(async () => {
    vi.stubEnv('AGENTCORE_TELEMETRY_DISABLED', '1');
    projectRoot = mkdtempSync(join(tmpdir(), 'container-export-'));
    vi.stubEnv('INIT_CWD', projectRoot);
    configIO = new ConfigIO({ baseDir: join(projectRoot, 'agentcore') });
    await configIO.writeProjectSpec(
      AgentCoreProjectSpecSchema.parse({
        name: 'ExportProbe',
        version: 1,
        harnesses: [{ name: 'SourceHarness', path: 'app/SourceHarness' }],
      })
    );
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('hardens a containerUri layer while preserving the base and requiring OS refresh', async () => {
    const baseImage = 'public.ecr.aws/example/custom-python:latest';
    await configIO.writeHarnessSpec(
      'SourceHarness',
      HarnessSpecSchema.parse({
        name: 'SourceHarness',
        model: { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' },
        containerUri: baseImage,
      })
    );

    const result = await handleExportHarness({ name: 'SourceHarness', targetAgentName: 'ExportedAgent' });

    if (!result.success) throw result.error;
    expect(result.success).toBe(true);
    const dockerfile = readFileSync(join(result.agentPath, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`FROM ${baseImage}`);
    expect(dockerfile).toContain('UV_NO_CACHE=1');
    expect(dockerfile).toContain('/usr/local/bin/python -m pip uninstall -y uv');
    expect(dockerfile).toContain('OS packages');
    expect(dockerfile).toContain('appropriate package manager');
    expect(dockerfile).not.toContain('apt-get upgrade');
    expect(dockerfile).toContain('CMD ["opentelemetry-instrument", "python", "-m", "main"]');
  });

  it('preserves a custom Dockerfile and emits hardened build-layer guidance', async () => {
    const original = 'FROM customer/base:latest\nRUN echo customer-customization\n';
    const harnessDir = join(projectRoot, 'app', 'SourceHarness');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, 'Custom.Dockerfile'), original);
    await configIO.writeHarnessSpec(
      'SourceHarness',
      HarnessSpecSchema.parse({
        name: 'SourceHarness',
        model: { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' },
        dockerfile: 'Custom.Dockerfile',
      })
    );

    const result = await handleExportHarness({ name: 'SourceHarness', targetAgentName: 'ExportedAgent' });

    if (!result.success) throw result.error;
    expect(result.success).toBe(true);
    expect(readFileSync(join(result.agentPath, 'Custom.Dockerfile'), 'utf8')).toBe(original);
    const notes = readFileSync(result.notesPath, 'utf8');
    expect(notes).toContain('UV_NO_CACHE=1');
    expect(notes).toContain('/usr/local/bin/python -m pip uninstall -y uv');
    expect(notes).toContain('OS packages');
    expect(notes).toContain('package manager');
  });
});
