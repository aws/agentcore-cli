import { createTestProject, exists, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function readHarnessSpec(projectPath: string, harnessName: string) {
  return JSON.parse(await readFile(join(projectPath, `app/${harnessName}/harness.json`), 'utf-8'));
}

// Placeholder ARNs/keys for config-shape tests (never resolved against AWS).
const OPENAI_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key';
const GEMINI_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gemini-key';
const GATEWAY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/abc123';
const MEMORY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/abc123';

describe('integration: harness add/remove lifecycle', () => {
  let project: TestProject;
  const harnessName = 'TestHarness';

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds a harness with defaults', async () => {
    const result = await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const harness = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(harness, `Harness "${harnessName}" should be in agentcore.json`).toBeTruthy();
    expect(harness!.path).toBe(`app/${harnessName}`);
  });

  it('creates harness.json with correct model config', async () => {
    const spec = await readHarnessSpec(project.projectPath, harnessName);
    expect(spec.model).toBeDefined();
    expect(spec.model.provider).toBe('bedrock');
    expect(spec.model.modelId).toBeTruthy();
  });

  it('creates system-prompt.md', async () => {
    const promptPath = join(project.projectPath, `app/${harnessName}/system-prompt.md`);
    expect(await exists(promptPath), 'system-prompt.md should exist').toBe(true);
  });

  it('defaults to disabled memory and creates NO sibling memory resource', async () => {
    // Memory is opt-in: with no memory flag the harness gets `disabled` (no memory). It must also NOT
    // auto-create a `${name}Memory` sibling in the project (the legacy pre-managed-memory behavior).
    const spec = await readHarnessSpec(project.projectPath, harnessName);
    expect(spec.memory?.mode, 'default harness memory should be disabled (opt-in)').toBe('disabled');

    const config = await readProjectConfig(project.projectPath);
    const sibling = (config.memories ?? []).find((m: { name: string }) => m.name === `${harnessName}Memory`);
    expect(sibling, 'no `${name}Memory` sibling should be auto-created').toBeFalsy();
  });

  it('rejects duplicate harness name', async () => {
    const result = await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('removes the harness', async () => {
    const result = await runCLI(['remove', 'harness', '--name', harnessName, '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const found = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(found, `Harness "${harnessName}" should be removed`).toBeFalsy();
  });

  it('re-adds harness after removal', async () => {
    const result = await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    // Clean up for next tests
    await runCLI(['remove', 'harness', '--name', harnessName, '--json'], project.projectPath);
  });
});

describe('integration: harness configuration options', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds harness with truncation strategy', async () => {
    const name = 'TruncHarness';
    const result = await runCLI(
      ['add', 'harness', '--name', name, '--truncation-strategy', 'sliding_window', '--json'],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.truncation?.strategy).toBe('sliding_window');
  });

  it('adds harness with lifecycle config', async () => {
    const name = 'LifecycleHarness';
    const result = await runCLI(
      ['add', 'harness', '--name', name, '--idle-timeout', '300', '--max-lifetime', '3600', '--json'],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.lifecycleConfig?.idleRuntimeSessionTimeout).toBe(300);
    expect(spec.lifecycleConfig?.maxLifetime).toBe(3600);
  });

  it('adds harness without memory when --no-memory is set', async () => {
    const name = 'NoMemHarness';
    const configBefore = await readProjectConfig(project.projectPath);
    const memoriesBefore = (configBefore.memories ?? []).length;

    const result = await runCLI(['add', 'harness', '--name', name, '--no-memory', '--json'], project.projectPath);

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const configAfter = await readProjectConfig(project.projectPath);
    const memoriesAfter = (configAfter.memories ?? []).length;
    expect(memoriesAfter).toBe(memoriesBefore);
  });

  it('adds harness with non-bedrock model provider', async () => {
    const name = 'OpenAIHarness';
    const result = await runCLI(
      [
        'add',
        'harness',
        '--name',
        name,
        '--model-provider',
        'open_ai',
        '--model-id',
        'gpt-5',
        '--api-key-arn',
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const spec = await readHarnessSpec(project.projectPath, name);
    expect(spec.model.provider).toBe('open_ai');
    expect(spec.model.modelId).toBe('gpt-5');
    expect(spec.model.apiKeyArn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key');
  });
});

describe('integration: harness validation errors', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('rejects invalid harness name with special characters', async () => {
    const result = await runCLI(['add', 'harness', '--name', 'bad-name!', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects harness name starting with a number', async () => {
    const result = await runCLI(['add', 'harness', '--name', '1BadName', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects add harness without --name when --json is passed', async () => {
    const result = await runCLI(['add', 'harness', '--json'], project.projectPath);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('integration: create project with harness', () => {
  let project: TestProject;
  const harnessName = 'CreateHarness';

  beforeAll(async () => {
    project = await createTestProject({ name: harnessName, noAgent: true });
    await runCLI(['add', 'harness', '--name', harnessName, '--json'], project.projectPath);
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('has correct project scaffolding', async () => {
    expect(await exists(join(project.projectPath, 'agentcore/agentcore.json'))).toBe(true);
    expect(await exists(join(project.projectPath, 'agentcore/cdk'))).toBe(true);
    expect(await exists(join(project.projectPath, `app/${harnessName}/harness.json`))).toBe(true);
    expect(await exists(join(project.projectPath, `app/${harnessName}/system-prompt.md`))).toBe(true);
  });

  it('has harness registered in project config', async () => {
    const config = await readProjectConfig(project.projectPath);
    const harness = config.harnesses?.find((h: { name: string }) => h.name === harnessName);
    expect(harness).toBeTruthy();
  });
});

// ============================================================================
// Config-shape coverage — model, tools, skills, memory modes, truncation, auth.
//
// All cases below share ONE project (one `create` spawn). Each `runCLI` is a
// real process spawn (~1.3s), so cases are kept to behaviors that the schema
// unit tests (src/schema/.../__tests__/harness.test.ts) don't already cover at
// the parse layer — i.e. CLI flag → action → spec-write wiring. Pure schema
// refinements (top-k/api-base provider gating, skill URI scheme) live in unit
// tests and are intentionally NOT duplicated here.
// ============================================================================

describe('integration: harness config shape', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
    // Resources referenced by name in the cases below.
    await runCLI(['add', 'memory', '--name', 'SharedMem', '--json'], project.projectPath);
    await runCLI(
      ['add', 'credential', '--name', 'gitCred', '--api-key', 'test-token-integ', '--json'],
      project.projectPath
    );
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('model configuration', () => {
    it('adds a lite_llm harness with --api-base and --additional-params', async () => {
      const name = 'LiteLlmHarness';
      const result = await runCLI(
        [
          'add',
          'harness',
          '--name',
          name,
          '--model-provider',
          'lite_llm',
          '--model-id',
          'together_ai/meta-llama/Llama-3-70b',
          '--api-base',
          'https://api.together.xyz/v1',
          '--additional-params',
          '{"drop_params":true}',
          '--no-memory',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.model.provider).toBe('lite_llm');
      expect(spec.model.apiBase).toBe('https://api.together.xyz/v1');
      expect(spec.model.additionalParams).toEqual({ drop_params: true });
    });

    it('adds a bedrock harness with --api-format converse_stream', async () => {
      const name = 'BedrockFmt';
      const result = await runCLI(
        [
          'add',
          'harness',
          '--name',
          name,
          '--model-provider',
          'bedrock',
          '--api-format',
          'converse_stream',
          '--no-memory',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.model.apiFormat).toBe('converse_stream');
    });

    // --api-format provider gating is enforced by the CLI validator (not just the schema),
    // so these exercise the wiring rather than duplicating a parse-layer unit test.
    it.each([
      {
        label: 'converse_stream for open_ai',
        args: ['--model-provider', 'open_ai', '--model-id', 'gpt-5', '--api-key-arn', OPENAI_KEY_ARN],
        apiFormat: 'converse_stream',
      },
      {
        label: 'any --api-format for gemini',
        args: ['--model-provider', 'gemini', '--model-id', 'gemini-2.0-flash', '--api-key-arn', GEMINI_KEY_ARN],
        apiFormat: 'responses',
      },
    ])('rejects $label', async ({ args, apiFormat }) => {
      const result = await runCLI(
        ['add', 'harness', '--name', 'BadFmt', ...args, '--api-format', apiFormat, '--no-memory', '--json'],
        project.projectPath
      );
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('tools (`add tool`)', () => {
    beforeAll(async () => {
      await runCLI(['add', 'harness', '--name', 'ToolHarness', '--no-memory', '--json'], project.projectPath);
    });

    it('adds remote_mcp, code_interpreter, gateway, and inline_function tools', async () => {
      const cmds: string[][] = [
        ['--type', 'remote_mcp', '--name', 'myMcp', '--url', 'https://mcp.example.com/sse'],
        ['--type', 'agentcore_code_interpreter', '--name', 'codeRunner'],
        ['--type', 'agentcore_gateway', '--name', 'gw', '--gateway-arn', GATEWAY_ARN, '--outbound-auth', 'awsIam'],
        [
          '--type',
          'inline_function',
          '--name',
          'lookup',
          '--description',
          'Look up a value',
          '--input-schema',
          '{"type":"object","properties":{"q":{"type":"string"}}}',
        ],
      ];
      for (const extra of cmds) {
        const result = await runCLI(
          ['add', 'tool', '--harness', 'ToolHarness', ...extra, '--json'],
          project.projectPath
        );
        expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      }

      const spec = await readHarnessSpec(project.projectPath, 'ToolHarness');
      const byName = (n: string) => spec.tools.find((t: { name: string }) => t.name === n);
      expect(byName('myMcp').config.remoteMcp.url).toBe('https://mcp.example.com/sse');
      expect(byName('codeRunner').type).toBe('agentcore_code_interpreter');
      expect(byName('gw').config.agentCoreGateway.gatewayArn).toBe(GATEWAY_ARN);
      expect(byName('gw').config.agentCoreGateway.outboundAuth).toEqual({ awsIam: {} });
      expect(byName('lookup').config.inlineFunction.description).toBe('Look up a value');
      expect(byName('lookup').config.inlineFunction.inputSchema).toEqual({
        type: 'object',
        properties: { q: { type: 'string' } },
      });
    });

    it.each([
      { label: 'remote_mcp without --url', args: ['--type', 'remote_mcp', '--name', 'noUrl'] },
      {
        label: 'inline_function without --input-schema',
        args: ['--type', 'inline_function', '--name', 'noSchema', '--description', 'Missing schema'],
      },
      {
        label: 'agentcore_gateway without --gateway-arn or --gateway',
        args: ['--type', 'agentcore_gateway', '--name', 'noArn'],
      },
    ])('rejects $label', async ({ args }) => {
      const result = await runCLI(['add', 'tool', '--harness', 'ToolHarness', ...args, '--json'], project.projectPath);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('skills (`add skill`)', () => {
    beforeAll(async () => {
      await runCLI(['add', 'harness', '--name', 'SkillHarness', '--no-memory', '--json'], project.projectPath);
    });

    it('adds path, s3, and git (+auth) skills', async () => {
      const cmds: string[][] = [
        ['--path', 'skills/my-skill'],
        ['--s3', 's3://my-bucket/skills/pack'],
        [
          '--git',
          'https://github.com/example/skills.git',
          '--git-path',
          'pack',
          '--credential',
          'gitCred',
          '--username',
          'git-user',
        ],
      ];
      for (const extra of cmds) {
        const result = await runCLI(
          ['add', 'skill', '--harness', 'SkillHarness', ...extra, '--json'],
          project.projectPath
        );
        expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      }

      const spec = await readHarnessSpec(project.projectPath, 'SkillHarness');
      expect(spec.skills.some((s: { path?: string }) => s.path === 'skills/my-skill')).toBe(true);
      expect(spec.skills.some((s: { s3Uri?: string }) => s.s3Uri === 's3://my-bucket/skills/pack')).toBe(true);
      const git = spec.skills.find((s: { gitUrl?: string }) => s.gitUrl === 'https://github.com/example/skills.git');
      expect(git.path).toBe('pack');
      expect(git.auth).toEqual({ credentialName: 'gitCred', username: 'git-user' });
    });

    it('adds AWS skills — all paths and a path filter', async () => {
      await runCLI(['add', 'harness', '--name', 'AwsSkillHarness', '--no-memory', '--json'], project.projectPath);

      const all = await runCLI(
        ['add', 'skill', '--harness', 'AwsSkillHarness', '--aws-skills', '--json'],
        project.projectPath
      );
      expect(all.exitCode, `stdout: ${all.stdout}, stderr: ${all.stderr}`).toBe(0);

      const filtered = await runCLI(
        ['add', 'skill', '--harness', 'AwsSkillHarness', '--aws-skills', 'core-skills/*', '--json'],
        project.projectPath
      );
      expect(filtered.exitCode, `stdout: ${filtered.stdout}, stderr: ${filtered.stderr}`).toBe(0);

      const spec = await readHarnessSpec(project.projectPath, 'AwsSkillHarness');
      // "all" → awsSkills with no paths key; filtered → awsSkills.paths includes the glob.
      expect(spec.skills.some((s: { awsSkills?: { paths?: string[] } }) => s.awsSkills && !s.awsSkills.paths)).toBe(
        true
      );
      expect(
        spec.skills.some((s: { awsSkills?: { paths?: string[] } }) => s.awsSkills?.paths?.includes('core-skills/*'))
      ).toBe(true);
    });
  });

  describe('memory modes', () => {
    it('adds a managed-memory harness with explicit strategies', async () => {
      const name = 'ManagedMemHarness';
      const result = await runCLI(
        [
          'add',
          'harness',
          '--name',
          name,
          '--memory-mode',
          'managed',
          '--memory-strategies',
          'SEMANTIC,EPISODIC',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.memory.mode).toBe('managed');
      expect(spec.memory.strategies).toEqual(['SEMANTIC', 'EPISODIC']);
    });

    it('defaults to disabled memory when no memory flags are passed (memory is opt-in)', async () => {
      const name = 'DefaultMemHarness';
      const result = await runCLI(['add', 'harness', '--name', name, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.memory.mode).toBe('disabled');
    });

    it('writes disabled memory for --memory-mode disabled (true opt-out, no sibling)', async () => {
      const name = 'DisabledMemHarness';
      const result = await runCLI(
        ['add', 'harness', '--name', name, '--memory-mode', 'disabled', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.memory.mode).toBe('disabled');
    });

    it('adds an existing-memory harness referencing a sibling by name with tuning', async () => {
      const name = 'ExistingMemHarness';
      const result = await runCLI(
        [
          'add',
          'harness',
          '--name',
          name,
          '--memory-mode',
          'existing',
          '--memory-name',
          'SharedMem',
          '--memory-messages-count',
          '20',
          '--memory-top-k',
          '5',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.memory.mode).toBe('existing');
      expect(spec.memory.name).toBe('SharedMem');
      expect(spec.memory.messagesCount).toBe(20);
      expect(spec.memory.retrievalConfig.topK).toBe(5);
    });

    it.each([
      {
        label: 'retrievalConfig tuning when memory is referenced by ARN',
        args: ['--memory-mode', 'existing', '--memory-arn', MEMORY_ARN, '--memory-top-k', '5'],
      },
      {
        label: '--memory-mode existing without a memory reference',
        args: ['--memory-mode', 'existing'],
      },
      {
        label: '--no-memory combined with managed-only flags (--memory-strategies)',
        args: ['--no-memory', '--memory-strategies', 'SEMANTIC'],
      },
    ])('rejects $label', async ({ args }) => {
      const result = await runCLI(['add', 'harness', '--name', 'BadMem', ...args, '--json'], project.projectPath);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('truncation', () => {
    it('adds a harness with summarization truncation', async () => {
      const name = 'SummHarness';
      const result = await runCLI(
        ['add', 'harness', '--name', name, '--truncation-strategy', 'summarization', '--no-memory', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.truncation.strategy).toBe('summarization');
    });
  });

  describe('VPC network-mode validation (no deploy)', () => {
    it.each([
      {
        label: '--subnets / --security-groups without --network-mode VPC',
        args: ['--subnets', 'subnet-123', '--security-groups', 'sg-123'],
      },
      { label: '--network-mode VPC without subnets/security groups', args: ['--network-mode', 'VPC'] },
    ])('rejects $label', async ({ args }) => {
      const result = await runCLI(
        ['add', 'harness', '--name', 'BadVpc', ...args, '--no-memory', '--json'],
        project.projectPath
      );
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('CUSTOM_JWT inbound authorizer', () => {
    it('adds a harness with a CUSTOM_JWT authorizer', async () => {
      const name = 'JwtHarness';
      const result = await runCLI(
        [
          'add',
          'harness',
          '--name',
          name,
          '--authorizer-type',
          'CUSTOM_JWT',
          '--discovery-url',
          'https://example.com/.well-known/openid-configuration',
          '--allowed-audience',
          'my-audience',
          '--no-memory',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const spec = await readHarnessSpec(project.projectPath, name);
      expect(spec.authorizerType).toBe('CUSTOM_JWT');
      expect(spec.authorizerConfiguration?.customJwtAuthorizer).toBeDefined();
    });

    it('rejects CUSTOM_JWT without authorizer configuration', async () => {
      const result = await runCLI(
        ['add', 'harness', '--name', 'JwtNoConfig', '--authorizer-type', 'CUSTOM_JWT', '--no-memory', '--json'],
        project.projectPath
      );
      expect(result.exitCode).not.toBe(0);
    });
  });
});
