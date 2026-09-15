import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { HarnessSpecSchema } from '../lib/harness-schema';

const entrypoint = resolve(__dirname, '..', 'dist/bin/cdk.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  { systemPrompt: '' },
  { systemPrompt: ' \r\n\t' },
])('retains published refinements for %j', (overrides) => {
  expect(HarnessSpecSchema.safeParse({
    name: 'assistant',
    model: { provider: 'bedrock', modelId: 'example' },
    ...overrides,
  }).success).toBe(false);
});

test.each([
  ...['literal', 'file', 'fallback'].map(source => ({
    source, prompt: '  Selected prompt: # 100%\n',
  })),
  ...['README.md\n', './instructions.md', 'https://example.com/prompt.md\n', 'file://./not-a-recursive-include.md'].map(prompt => ({
    source: 'file', prompt,
  })),
  { source: 'literal', prompt: './instructions.md' },
  { source: 'fallback', prompt: 'README.md\n' },
])('generated app validates $source prompt $prompt without rewriting it', ({ source, prompt }) => {
  const root = mkdtempSync(join(tmpdir(), 'harness-yaml-synth-'));
  roots.push(root);
  const configRoot = join(root, 'agentcore');
  const cdkRoot = join(configRoot, 'cdk');
  const harnessDir = join(root, 'app', 'assistant');
  mkdirSync(cdkRoot, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(configRoot, 'agentcore.json'), JSON.stringify({
    name: 'YamlProject',
    version: 1,
    managedBy: 'CDK',
    harnesses: [{ name: 'assistant', path: 'app/assistant' }],
  }));
  writeFileSync(join(configRoot, 'aws-targets.json'), '[]');
  const summary = 'Keep decisions and open questions.\n';
  writeFileSync(join(harnessDir, 'chosen #100%.md'), prompt);
  writeFileSync(join(harnessDir, 'system-prompt.md'), source === 'fallback' ? prompt : 'Conventional prompt loses.');
  writeFileSync(join(harnessDir, 'summary.md'), summary);
  const yaml = '# Customer comment stays intact.\n' + stringify({
    name: 'assistant',
    model: {
      provider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
    },
    systemPrompt: source === 'fallback' ? undefined : source === 'literal' ? prompt : 'file://./chosen #100%.md',
    memory: { mode: 'disabled' },
    truncation: {
      strategy: 'summarization',
      config: { summarization: { summaryRatio: 0.3, preserveRecentMessages: 0, summarizationSystemPrompt: 'file://./summary.md' } },
    },
  });
  writeFileSync(join(harnessDir, 'harness.yaml'), yaml);
  const outdir = join(root, 'cdk.out');
  execFileSync(process.execPath, [entrypoint], {
    cwd: cdkRoot,
    env: { ...process.env, INIT_CWD: root, CDK_OUTDIR: outdir },
    stdio: 'pipe',
    timeout: 30000,
  });
  expect(readFileSync(join(harnessDir, 'harness.yaml'), 'utf8')).toBe(yaml);
  const templateFile = readdirSync(outdir).find((name) => name.endsWith('.template.json'))!;
  const template = JSON.parse(readFileSync(join(outdir, templateFile), 'utf8'));
  const harness = Object.values(template.Resources).find((resource: any) => resource.Type === 'AWS::BedrockAgentCore::Harness') as any;
  expect(harness.Properties.SystemPrompt).toEqual([{ Text: prompt }]);
  expect(harness.Properties.Memory).toEqual({ Disabled: {} });
  expect(JSON.stringify(harness.Properties)).toContain(JSON.stringify(summary).slice(1, -1));
  expect(JSON.stringify(harness.Properties)).not.toContain('file://./chosen #100%.md');
  expect(JSON.stringify(harness.Properties)).not.toContain('file://./summary.md');
  expect(readFileSync(join(harnessDir, 'chosen #100%.md'), 'utf8')).toBe(prompt);
  expect(readFileSync(join(harnessDir, 'harness.yaml'), 'utf8')).toBe(yaml);
});
