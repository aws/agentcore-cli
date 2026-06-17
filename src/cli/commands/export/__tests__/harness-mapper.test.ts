import type { HarnessSpec } from '../../../../schema/schemas/primitives/harness';
import {
  ALLOWED_TOOLS_NOTE_CATEGORY,
  AWS_SKILLS_NOTE_CATEGORY,
  BROWSER_CODZIP_NOTE_CATEGORY,
  BROWSER_IAM_POLICY_NOTE_CATEGORY,
  CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY,
  CONTAINER_URI_ECR_PULL_NOTE_CATEGORY,
  CONTAINER_URI_NOTE_CATEGORY,
  EXTERNAL_GATEWAY_NOTE_CATEGORY,
  GATEWAY_IAM_POLICY_NOTE_CATEGORY,
  GIT_SKILLS_CONTAINER_NOTE_CATEGORY,
  MCP_HEADER_CREDS_NOTE_CATEGORY,
  MEMORY_ARN_NOTE_CATEGORY,
  PATH_SKILLS_NOTE_CATEGORY,
  S3_SKILLS_IAM_POLICY_NOTE_CATEGORY,
} from '../constants';
import { mapHarnessToExportConfig } from '../harness-mapper';
import type { ResolvedHarnessContext } from '../types';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Test helpers
// ============================================================================

function baseSpec(overrides: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    name: 'TestHarness',
    model: { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' },
    tools: [],
    skills: [],
    ...overrides,
  } as HarnessSpec;
}

function baseContext(
  specOverrides: Partial<HarnessSpec> = {},
  contextOverrides: Partial<ResolvedHarnessContext> = {}
): ResolvedHarnessContext {
  return {
    harnessName: 'TestHarness',
    targetAgentName: 'TestAgent',
    spec: baseSpec(specOverrides),
    systemPrompt: 'You are helpful.',
    projectSpec: { name: 'myproject', runtimes: [], memories: [], credentials: [], harnesses: [] } as any,
    deployedResources: null,
    configBaseDir: '/project/agentcore',
    projectRoot: '/project',
    exportNotes: [],
    region: 'us-east-1',
    ...contextOverrides,
  };
}

function noteCategories(context: ResolvedHarnessContext): string[] {
  return context.exportNotes.map(n => n.category);
}

// ============================================================================
// CodeZip + container suppression
// ============================================================================

describe('CodeZip suppression for container harnesses', () => {
  it('throws when containerUri is set and build is CodeZip', () => {
    const ctx = baseContext({ containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' });
    expect(() => mapHarnessToExportConfig(ctx, 'CodeZip')).toThrow(/containerUri.*requires a Container build/);
  });

  it('throws when dockerfile is set and build is CodeZip', () => {
    const ctx = baseContext({ dockerfile: 'Dockerfile.custom' });
    expect(() => mapHarnessToExportConfig(ctx, 'CodeZip')).toThrow(/dockerfile.*requires a Container build/);
  });

  it('succeeds when containerUri is set and build is Container', () => {
    const ctx = baseContext({ containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' });
    expect(() => mapHarnessToExportConfig(ctx, 'Container')).not.toThrow();
  });

  it('succeeds when dockerfile is set and build is Container', () => {
    const ctx = baseContext({ dockerfile: 'Dockerfile.custom' });
    expect(() => mapHarnessToExportConfig(ctx, 'Container')).not.toThrow();
  });

  it('includes containerUri note for Container build', () => {
    const ctx = baseContext({ containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(CONTAINER_URI_NOTE_CATEGORY);
  });

  it('does not include containerUri note for plain CodeZip harness', () => {
    const ctx = baseContext();
    mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(noteCategories(ctx)).not.toContain(CONTAINER_URI_NOTE_CATEGORY);
  });

  it('includes ECR pull note when base image is a private ECR repository', () => {
    const ctx = baseContext({ containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-base:latest' });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(CONTAINER_URI_ECR_PULL_NOTE_CATEGORY);
    const note = ctx.exportNotes.find(n => n.category === CONTAINER_URI_ECR_PULL_NOTE_CATEGORY);
    // Note carries the resolved ECR repo ARN and a working grantPull snippet.
    expect(note?.message).toContain('arn:aws:ecr:us-east-1:123456789012:repository/my-base');
    expect(note?.message).toContain('ContainerBuildProject.getOrCreate(this).role');
  });

  it('does not include ECR pull note when base image is a public registry', () => {
    const ctx = baseContext({ containerUri: 'public.ecr.aws/docker/library/python:3.12-slim' });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(CONTAINER_URI_NOTE_CATEGORY);
    expect(noteCategories(ctx)).not.toContain(CONTAINER_URI_ECR_PULL_NOTE_CATEGORY);
  });
});

// ============================================================================
// Browser tool — CodeZip exclusion + Container inclusion
// ============================================================================

describe('browser tool handling', () => {
  const browserTool = { type: 'agentcore_browser' as const, name: 'browser' };

  it('sets hasBrowser=false and emits CodeZip note for CodeZip build', () => {
    const ctx = baseContext({ tools: [browserTool] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasBrowser).toBe(false);
    expect(noteCategories(ctx)).toContain(BROWSER_CODZIP_NOTE_CATEGORY);
  });

  it('sets hasBrowser=true and emits IAM note for Container build', () => {
    const ctx = baseContext({ tools: [browserTool] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.hasBrowser).toBe(true);
    expect(noteCategories(ctx)).toContain(BROWSER_IAM_POLICY_NOTE_CATEGORY);
  });

  it('CodeZip note re-export hint uses --name flag', () => {
    const ctx = baseContext({ tools: [browserTool] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === BROWSER_CODZIP_NOTE_CATEGORY)!;
    expect(note.message).toContain('--name TestHarness');
    expect(note.message).not.toContain('--harness');
  });

  it('IAM note uses default browser ARN when no custom browserArn', () => {
    const ctx = baseContext({ tools: [browserTool] });
    mapHarnessToExportConfig(ctx, 'Container');
    const note = ctx.exportNotes.find(n => n.category === BROWSER_IAM_POLICY_NOTE_CATEGORY)!;
    expect(note.message).toContain(':aws:browser/*');
  });

  it('IAM note uses custom browserArn when provided', () => {
    const ctx = baseContext({
      tools: [
        {
          ...browserTool,
          config: {
            agentCoreBrowser: { browserArn: 'arn:aws:bedrock-agentcore:us-east-1:123:browser-custom/my_browser_id' },
          },
        },
      ],
    });
    mapHarnessToExportConfig(ctx, 'Container');
    const note = ctx.exportNotes.find(n => n.category === BROWSER_IAM_POLICY_NOTE_CATEGORY)!;
    expect(note.message).toContain('arn:aws:bedrock-agentcore:us-east-1:123:browser-custom/my_browser_id');
  });
});

// ============================================================================
// Code interpreter tool
// ============================================================================

describe('code interpreter tool handling', () => {
  const ciTool = { type: 'agentcore_code_interpreter' as const, name: 'code-interpreter' };

  it('sets hasCodeInterpreter=true for CodeZip build', () => {
    const ctx = baseContext({ tools: [ciTool] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasCodeInterpreter).toBe(true);
  });

  it('emits IAM note with default ARN', () => {
    const ctx = baseContext({ tools: [ciTool] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY)!;
    expect(note.message).toContain(':aws:code-interpreter/*');
  });

  it('emits IAM note with custom codeInterpreterArn when provided', () => {
    const ctx = baseContext({
      tools: [
        {
          ...ciTool,
          config: {
            agentCoreCodeInterpreter: {
              codeInterpreterArn: 'arn:aws:bedrock-agentcore:us-east-1:123:code-interpreter-custom/my_ci_id',
            },
          },
        },
      ],
    });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY)!;
    expect(note.message).toContain('arn:aws:bedrock-agentcore:us-east-1:123:code-interpreter-custom/my_ci_id');
  });
});

// ============================================================================
// Custom tool identifier extraction (browserIdentifier / codeInterpreterIdentifier)
// ============================================================================

describe('custom tool identifier extraction', () => {
  it('extracts browserIdentifier from browserArn', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'agentcore_browser' as const,
          name: 'browser',
          config: {
            agentCoreBrowser: { browserArn: 'arn:aws:bedrock-agentcore:us-east-1:123:browser-custom/browser_abc123' },
          },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.browserIdentifier).toBe('browser_abc123');
  });

  it('sets browserIdentifier=undefined when no custom browserArn', () => {
    const ctx = baseContext({ tools: [{ type: 'agentcore_browser' as const, name: 'browser' }] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.browserIdentifier).toBeUndefined();
  });

  it('extracts codeInterpreterIdentifier from codeInterpreterArn', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'agentcore_code_interpreter' as const,
          name: 'ci',
          config: {
            agentCoreCodeInterpreter: {
              codeInterpreterArn: 'arn:aws:bedrock-agentcore:us-east-1:123:code-interpreter-custom/ci_xyz789',
            },
          },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.codeInterpreterIdentifier).toBe('ci_xyz789');
  });

  it('sets codeInterpreterIdentifier=undefined when no custom codeInterpreterArn', () => {
    const ctx = baseContext({ tools: [{ type: 'agentcore_code_interpreter' as const, name: 'ci' }] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.codeInterpreterIdentifier).toBeUndefined();
  });
});

// ============================================================================
// allowedTools filtering
// ============================================================================

describe('allowedTools filtering', () => {
  const browserTool = { type: 'agentcore_browser' as const, name: 'browser' };
  const ciTool = { type: 'agentcore_code_interpreter' as const, name: 'code-interpreter' };

  it('excludes browser when not in allowedTools', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['code-interpreter'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.hasBrowser).toBe(false);
    expect(renderConfig.hasCodeInterpreter).toBe(true);
  });

  it('excludes code interpreter when not in allowedTools', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['browser'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.hasBrowser).toBe(true);
    expect(renderConfig.hasCodeInterpreter).toBe(false);
  });

  it('includes all tools when allowedTools is wildcard', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['*'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.hasBrowser).toBe(true);
    expect(renderConfig.hasCodeInterpreter).toBe(true);
  });

  it('emits allowedTools note when filter is not wildcard', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['code-interpreter'] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(ALLOWED_TOOLS_NOTE_CATEGORY);
  });

  it('does not emit allowedTools note when filter is wildcard', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['*'] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(ALLOWED_TOOLS_NOTE_CATEGORY);
  });

  it('does not emit allowedTools note when no allowedTools set (defaults to wildcard)', () => {
    const ctx = baseContext({ tools: [browserTool] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(ALLOWED_TOOLS_NOTE_CATEGORY);
  });

  it('does not emit browser IAM note when browser excluded by allowedTools on Container build', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['code-interpreter'] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(BROWSER_IAM_POLICY_NOTE_CATEGORY);
  });

  it('does not emit code interpreter IAM note when CI excluded by allowedTools', () => {
    const ctx = baseContext({ tools: [browserTool, ciTool], allowedTools: ['browser'] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY);
  });
});

// ============================================================================
// Truncation config translation
// ============================================================================

describe('truncation config translation', () => {
  it('translates sliding_window messagesCount to window_size', () => {
    const ctx = baseContext({
      truncation: { strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 4 } } },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationStrategy).toBe('sliding_window');
    expect(renderConfig.truncationConfig).toEqual({ window_size: 4 });
  });

  it('returns undefined truncationConfig when no messagesCount', () => {
    const ctx = baseContext({ truncation: { strategy: 'sliding_window' } });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationStrategy).toBe('sliding_window');
    expect(renderConfig.truncationConfig).toBeUndefined();
  });

  it('translates all summarization fields to snake_case', () => {
    const ctx = baseContext({
      truncation: {
        strategy: 'summarization',
        config: {
          summarization: {
            summaryRatio: 0.3,
            preserveRecentMessages: 2,
            summarizationSystemPrompt: 'Be concise.',
          },
        },
      },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationStrategy).toBe('summarization');
    expect(renderConfig.truncationConfig).toEqual({
      summary_ratio: 0.3,
      preserve_recent_messages: 2,
      summarization_system_prompt: 'Be concise.',
    });
  });

  it('translates partial summarization fields', () => {
    const ctx = baseContext({
      truncation: { strategy: 'summarization', config: { summarization: { summaryRatio: 0.5 } } },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationConfig).toEqual({ summary_ratio: 0.5 });
  });

  it('returns undefined truncationConfig when summarization has no fields', () => {
    const ctx = baseContext({ truncation: { strategy: 'summarization' } });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationConfig).toBeUndefined();
  });

  it('returns undefined truncationStrategy when no truncation configured', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationStrategy).toBeUndefined();
    expect(renderConfig.truncationConfig).toBeUndefined();
  });
});

// ============================================================================
// Build type auto-detection
// ============================================================================

describe('build type auto-detection', () => {
  it('defaults to CodeZip when no override and no container fields', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx);
    expect(renderConfig.buildType).toBe('CodeZip');
  });

  it('defaults to Container when containerUri is present', () => {
    const ctx = baseContext({ containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' });
    const { renderConfig } = mapHarnessToExportConfig(ctx);
    expect(renderConfig.buildType).toBe('Container');
  });

  it('defaults to Container when dockerfile is present', () => {
    const ctx = baseContext({ dockerfile: 'Dockerfile' });
    const { renderConfig } = mapHarnessToExportConfig(ctx);
    expect(renderConfig.buildType).toBe('Container');
  });

  it('override takes precedence over spec fields', () => {
    const ctx = baseContext({ containerUri: '123.dkr.ecr.us-east-1.amazonaws.com/img:latest' });
    // Container override — no throw since it matches the spec
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.buildType).toBe('Container');
  });
});

// ============================================================================
// Skills notes
// ============================================================================

describe('skills notes', () => {
  it('emits path skills note when path skills present and build is CodeZip', () => {
    const ctx = baseContext({ skills: [{ path: 'skills/my_skill' }] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(noteCategories(ctx)).toContain(PATH_SKILLS_NOTE_CATEGORY);
  });

  it('does not emit path skills note for Container build', () => {
    const ctx = baseContext({ skills: [{ path: 'skills/my_skill' }] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(PATH_SKILLS_NOTE_CATEGORY);
  });

  it('emits git skills note for Container build', () => {
    const ctx = baseContext({ skills: [{ gitUrl: 'https://github.com/org/repo' }] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(GIT_SKILLS_CONTAINER_NOTE_CATEGORY);
  });

  it('does not emit git skills note for CodeZip build', () => {
    const ctx = baseContext({ skills: [{ gitUrl: 'https://github.com/org/repo' }] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(noteCategories(ctx)).not.toContain(GIT_SKILLS_CONTAINER_NOTE_CATEGORY);
  });

  it('emits s3 skills IAM note with GetObject + ListBucket ARNs for CodeZip', () => {
    const ctx = baseContext({ skills: [{ s3Uri: 's3://my-bucket/skills/weather/' }] }, { targetAgentName: 'MyAgent' });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(noteCategories(ctx)).toContain(S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
    const note = ctx.exportNotes.find(n => n.category === S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
    // Object-level read scoped to the prefix
    expect(note?.message).toContain("actions: ['s3:GetObject']");
    expect(note?.message).toContain("'arn:aws:s3:::my-bucket/skills/weather/*'");
    // List scoped to the bucket
    expect(note?.message).toContain("actions: ['s3:ListBucket']");
    expect(note?.message).toContain("'arn:aws:s3:::my-bucket'");
    // Snippet targets the renamed agent
    expect(note?.message).toContain("this.application.environments.get('MyAgent')");
  });

  it('emits s3 skills IAM note for Container builds too (independent of build type)', () => {
    const ctx = baseContext({ skills: [{ s3Uri: 's3://my-bucket/skills/weather/' }] });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).toContain(S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
  });

  it('uses bucket-root object ARN when the s3 URI has no prefix', () => {
    const ctx = baseContext({ skills: [{ s3Uri: 's3://my-bucket' }] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
    expect(note?.message).toContain("'arn:aws:s3:::my-bucket/*'");
    expect(note?.message).toContain("'arn:aws:s3:::my-bucket'");
  });

  it('deduplicates ARNs across multiple s3 skills in the same bucket', () => {
    const ctx = baseContext({
      skills: [{ s3Uri: 's3://shared/a/' }, { s3Uri: 's3://shared/b/' }],
    });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
    // One ListBucket resource for the shared bucket, two distinct object ARNs
    expect(note?.message).toContain("'arn:aws:s3:::shared/a/*'");
    expect(note?.message).toContain("'arn:aws:s3:::shared/b/*'");
    expect(note?.message.match(/arn:aws:s3:::shared'/g)?.length).toBe(1);
  });

  it('uses the GovCloud partition prefix for gov regions', () => {
    const ctx = baseContext({ skills: [{ s3Uri: 's3://gov-bucket/skills/' }] }, { region: 'us-gov-west-1' });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    const note = ctx.exportNotes.find(n => n.category === S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
    expect(note?.message).toContain("'arn:aws-us-gov:s3:::gov-bucket/skills/*'");
  });

  it('does not emit s3 skills IAM note when there are no s3 skills', () => {
    const ctx = baseContext({ skills: [{ path: 'skills/local' }] });
    mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(noteCategories(ctx)).not.toContain(S3_SKILLS_IAM_POLICY_NOTE_CATEGORY);
  });
});

// ============================================================================
// skills render config mapping (new flat schema shape)
// ============================================================================

describe('skills render config mapping', () => {
  it('maps path, s3, and git skills into the render config', () => {
    const ctx = baseContext({
      skills: [
        { path: 'skills/local' },
        { s3Uri: 's3://bucket/skills/xlsx/' },
        {
          gitUrl: 'https://github.com/org/repo',
          path: 'skills/x',
          auth: { credentialName: 'MyGitCred', username: 'me' },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.pathSkills).toEqual(['skills/local']);
    expect(renderConfig.s3Skills).toEqual(['s3://bucket/skills/xlsx/']);
    expect(renderConfig.gitSkills).toEqual([
      { url: 'https://github.com/org/repo', path: 'skills/x', credentialArn: 'MyGitCred', username: 'me' },
    ]);
    expect(renderConfig.hasFetchedSkills).toBe(true);
  });

  it('does not include AWS skills in path/s3/git render config arrays and emits export note', () => {
    const ctx = baseContext({
      skills: [{ path: 'skills/local' }, { awsSkills: { paths: ['core-skills/*'] } }],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.pathSkills).toEqual(['skills/local']);
    expect(renderConfig.s3Skills).toEqual([]);
    expect(renderConfig.gitSkills).toEqual([]);
    expect(renderConfig.hasFetchedSkills).toBe(false);
    expect(noteCategories(ctx)).toContain(AWS_SKILLS_NOTE_CATEGORY);
    const note = ctx.exportNotes.find(n => n.category === AWS_SKILLS_NOTE_CATEGORY);
    expect(note?.message).toContain('core-skills/*');
    expect(note?.message).toContain('https://github.com/aws/agent-toolkit-for-aws/tree/main/skills');
  });

  it('does not emit AWS skills note when no AWS skills are present', () => {
    const ctx = baseContext({
      skills: [{ path: 'skills/local' }, { s3Uri: 's3://bucket/skill' }],
    });
    mapHarnessToExportConfig(ctx, 'Container');
    expect(noteCategories(ctx)).not.toContain(AWS_SKILLS_NOTE_CATEGORY);
  });
});

// ============================================================================
// model provider
// ============================================================================

describe('resolveModelProvider', () => {
  it('rejects the lite_llm provider (unsupported by Strands export)', () => {
    const ctx = baseContext({ model: { provider: 'lite_llm', modelId: 'some-model' } as never });
    expect(() => mapHarnessToExportConfig(ctx, 'CodeZip')).toThrow(/lite_llm.*does not support/);
  });
});

// ============================================================================
// extractToolIdentifier edge cases
// ============================================================================

describe('extractToolIdentifier edge cases', () => {
  it('returns undefined when ARN has no slash', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'agentcore_browser' as const,
          name: 'browser',
          config: { agentCoreBrowser: { browserArn: 'arn:aws:bedrock-agentcore:us-east-1:123:noslash' } },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.browserIdentifier).toBeUndefined();
  });

  it('returns undefined when browserArn is empty string', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'agentcore_browser' as const,
          name: 'browser',
          config: { agentCoreBrowser: { browserArn: '' } },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'Container');
    expect(renderConfig.browserIdentifier).toBeUndefined();
  });
});

// ============================================================================
// resolveTruncationConfig edge cases
// ============================================================================

describe('resolveTruncationConfig edge cases', () => {
  it('returns undefined when sliding_window config has no slidingWindow key', () => {
    const ctx = baseContext({
      truncation: { strategy: 'sliding_window', config: {} as any },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationConfig).toBeUndefined();
  });

  it('returns undefined for unknown strategy', () => {
    const ctx = baseContext({
      truncation: { strategy: 'sliding_window', config: { unknownKey: { foo: 1 } } as any },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.truncationConfig).toBeUndefined();
  });
});

// ============================================================================
// resolveMemoryProviders
// ============================================================================

describe('resolveMemoryProviders', () => {
  it('returns empty providers when no memory configured', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasMemory).toBe(false);
    expect(renderConfig.memoryProviders).toHaveLength(0);
  });

  it('resolves same-project memory by name with env var', () => {
    const ctx = baseContext(
      { memory: { mode: 'existing', name: 'MyMemory' } },
      {
        projectSpec: {
          name: 'myproject',
          runtimes: [],
          memories: [{ name: 'MyMemory', strategies: [] }],
          credentials: [],
          harnesses: [],
        } as any,
      }
    );
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasMemory).toBe(true);
    expect(renderConfig.memoryProviders).toHaveLength(1);
    expect(renderConfig.memoryProviders?.at(0)!.name).toBe('MyMemory');
    expect(renderConfig.memoryProviders?.at(0)!.envVarName).toBe('MEMORY_MYMEMORY_ID');
  });

  it('resolves memory by ARN via deployed state match', () => {
    const memArn = 'arn:aws:bedrock-agentcore:us-east-1:123:memory/abc123';
    const ctx = baseContext(
      { memory: { mode: 'existing', arn: memArn } },
      {
        deployedResources: {
          memories: { DeployedMem: { memoryArn: memArn } },
        } as any,
        projectSpec: {
          name: 'myproject',
          runtimes: [],
          memories: [{ name: 'DeployedMem', strategies: [] }],
          credentials: [],
          harnesses: [],
        } as any,
      }
    );
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasMemory).toBe(true);
    expect(renderConfig.memoryProviders?.at(0)!.name).toBe('DeployedMem');
    expect(renderConfig.memoryProviders?.at(0)!.envVarName).toBe('MEMORY_DEPLOYEDMEM_ID');
  });

  it('falls back to MEMORY_ARN env var for external memory ARN and emits note', () => {
    const ctx = baseContext(
      { memory: { mode: 'existing', arn: 'arn:aws:bedrock-agentcore:us-east-1:999:memory/external' } },
      { deployedResources: null }
    );
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasMemory).toBe(true);
    expect(renderConfig.memoryProviders?.at(0)!.envVarName).toBe('MEMORY_ARN');
    expect(noteCategories(ctx)).toContain(MEMORY_ARN_NOTE_CATEGORY);
  });
});

// ============================================================================
// model ID propagation
// ============================================================================

describe('model ID propagation to renderConfig', () => {
  it('propagates the bedrock model ID', () => {
    const ctx = baseContext({ model: { provider: 'bedrock', modelId: 'anthropic.claude-3' } });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.modelId).toBe('anthropic.claude-3');
  });

  it('propagates the OpenAI model ID (does not hardcode gpt-4.1)', () => {
    const ctx = baseContext({
      model: {
        provider: 'open_ai',
        modelId: 'gpt-4o',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/openai',
      },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.modelId).toBe('gpt-4o');
  });

  it('propagates the Gemini model ID (does not hardcode gemini-2.5-flash)', () => {
    const ctx = baseContext({
      model: {
        provider: 'gemini',
        modelId: 'gemini-1.5-pro',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/gemini',
      },
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.modelId).toBe('gemini-1.5-pro');
  });
});

// ============================================================================
// resolveIdentityProvider
// ============================================================================

describe('resolveIdentityProvider', () => {
  it('returns no identity provider for bedrock model', () => {
    const ctx = baseContext({ model: { provider: 'bedrock', modelId: 'anthropic.claude-3' } });
    const { renderConfig, credentialEntry } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasIdentity).toBe(false);
    expect(renderConfig.identityProviders).toHaveLength(0);
    expect(credentialEntry).toBeNull();
  });

  it('creates new credential entry for OpenAI model with apiKeyArn', () => {
    const ctx = baseContext({
      model: {
        provider: 'open_ai',
        modelId: 'gpt-4o',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/openai',
      },
    });
    const { renderConfig, credentialEntry } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasIdentity).toBe(true);
    expect(renderConfig.identityProviders).toHaveLength(1);
    expect(credentialEntry).not.toBeNull();
    expect(credentialEntry!.name).toContain('OpenAI');
  });

  it('creates new credential entry for Gemini model', () => {
    const ctx = baseContext({
      model: {
        provider: 'gemini',
        modelId: 'gemini-1.5-pro',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret/gemini',
      },
    });
    const { renderConfig, credentialEntry } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasIdentity).toBe(true);
    expect(credentialEntry!.name).toContain('Gemini');
  });

  it('reuses existing credential when apiKeyArn matches project credential', () => {
    const apiKeyArn = 'arn:aws:secretsmanager:us-east-1:123:secret/openai';
    const ctx = baseContext(
      { model: { provider: 'open_ai', modelId: 'gpt-4o', apiKeyArn } },
      {
        projectSpec: {
          name: 'myproject',
          runtimes: [],
          memories: [],
          credentials: [{ name: 'ExistingOpenAI', authorizerType: 'ApiKeyCredentialProvider', apiKeyArn }],
          harnesses: [],
        } as any,
      }
    );
    const { renderConfig, credentialEntry } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.identityProviders?.at(0)!.name).toBe('ExistingOpenAI');
    expect(credentialEntry).toBeNull(); // already in project, no new entry
  });

  it('returns no identity when non-bedrock model has no apiKeyArn', () => {
    const ctx = baseContext({ model: { provider: 'open_ai', modelId: 'gpt-4o' } });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasIdentity).toBe(false);
  });
});

// ============================================================================
// resolveGatewayProviders
// ============================================================================

describe('resolveGatewayProviders', () => {
  const gatewayArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-abc123';
  const gatewayTool = {
    type: 'agentcore_gateway' as const,
    name: 'my-gateway',
    config: { agentCoreGateway: { gatewayArn } },
  };

  it('returns no gateway providers when no gateway tools', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasGateway).toBe(false);
    expect(renderConfig.gatewayProviders).toHaveLength(0);
  });

  it('resolves same-project gateway via deployed state without IAM note', () => {
    const ctx = baseContext(
      { tools: [gatewayTool] },
      {
        deployedResources: {
          mcp: { gateways: { MyGateway: { gatewayArn } } },
        } as any,
        projectSpec: {
          name: 'myproject',
          runtimes: [],
          memories: [],
          credentials: [],
          harnesses: [],
          agentCoreGateways: [{ name: 'MyGateway', authorizerType: 'AWS_IAM' }],
        } as any,
      }
    );
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasGateway).toBe(true);
    expect(renderConfig.gatewayProviders?.at(0)!.name).toBe('MyGateway');
    expect(renderConfig.gatewayProviders?.at(0)!.authType).toBe('AWS_IAM');
    expect(noteCategories(ctx)).not.toContain(GATEWAY_IAM_POLICY_NOTE_CATEGORY);
  });

  it('resolves same-project CUSTOM_JWT gateway with discoveryUrl and scopes', () => {
    const ctx = baseContext(
      { tools: [gatewayTool] },
      {
        deployedResources: {
          mcp: { gateways: { MyGateway: { gatewayArn } } },
        } as any,
        projectSpec: {
          name: 'myproject',
          runtimes: [],
          memories: [],
          credentials: [],
          harnesses: [],
          agentCoreGateways: [
            {
              name: 'MyGateway',
              authorizerType: 'CUSTOM_JWT',
              authorizerConfiguration: {
                customJwtAuthorizer: {
                  discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
                  allowedScopes: ['read', 'write'],
                },
              },
            },
          ],
        } as any,
      }
    );
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    const provider = renderConfig.gatewayProviders.find(() => true);
    expect(provider?.authType).toBe('CUSTOM_JWT');
    expect(provider?.discoveryUrl).toBe('https://auth.example.com/.well-known/openid-configuration');
    expect(provider?.scopes).toBe('read write');
    expect(noteCategories(ctx)).not.toContain(GATEWAY_IAM_POLICY_NOTE_CATEGORY);
  });

  it('hardcodes URL for external gateway and emits external note + IAM note', () => {
    const ctx = baseContext({ tools: [gatewayTool] }, { deployedResources: null });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasGateway).toBe(true);
    const provider = renderConfig.gatewayProviders.find(() => true);
    expect(provider?.hardcodedUrl).toContain('gateway.bedrock-agentcore');
    expect(noteCategories(ctx)).toContain(EXTERNAL_GATEWAY_NOTE_CATEGORY);
    expect(noteCategories(ctx)).toContain(GATEWAY_IAM_POLICY_NOTE_CATEGORY);
  });

  it('excludes gateway tool filtered out by allowedTools', () => {
    const ctx = baseContext({ tools: [gatewayTool], allowedTools: ['other-tool'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasGateway).toBe(false);
  });
});

// ============================================================================
// resolveRemoteMcpTools
// ============================================================================

describe('resolveRemoteMcpTools', () => {
  it('returns remote MCP tool with URL', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'remote_mcp' as const,
          name: 'my-mcp',
          config: { remoteMcp: { url: 'https://mcp.example.com/sse' } },
        },
      ],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.remoteMcpTools).toHaveLength(1);
    expect(renderConfig.remoteMcpTools?.at(0)!.url).toBe('https://mcp.example.com/sse');
    expect(renderConfig.remoteMcpTools?.at(0)!.name).toBe('my-mcp');
  });

  it('generates credential entries for MCP tools with headers', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'remote_mcp' as const,
          name: 'my-mcp',
          config: {
            remoteMcp: {
              url: 'https://mcp.example.com/sse',
              headers: { Authorization: 'Bearer secret-token' },
            },
          },
        },
      ],
    });
    const { mcpCredentialEntries } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(mcpCredentialEntries).toHaveLength(1);
    expect(mcpCredentialEntries.at(0)!.value).toBe('Bearer secret-token');
    expect(mcpCredentialEntries.at(0)!.credential.name).toContain('Mcp');
    expect(noteCategories(ctx)).toContain(MCP_HEADER_CREDS_NOTE_CATEGORY);
  });

  it('returns no credential entries for MCP tools without headers', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'remote_mcp' as const,
          name: 'my-mcp',
          config: { remoteMcp: { url: 'https://mcp.example.com/sse' } },
        },
      ],
    });
    const { mcpCredentialEntries } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(mcpCredentialEntries).toHaveLength(0);
    expect(noteCategories(ctx)).not.toContain(MCP_HEADER_CREDS_NOTE_CATEGORY);
  });

  it('excludes remote MCP tool filtered by allowedTools', () => {
    const ctx = baseContext({
      tools: [
        {
          type: 'remote_mcp' as const,
          name: 'my-mcp',
          config: { remoteMcp: { url: 'https://mcp.example.com/sse' } },
        },
      ],
      allowedTools: ['other-tool'],
    });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.remoteMcpTools).toHaveLength(0);
  });
});

// ============================================================================
// resolveInlineFunctionTools
// ============================================================================

describe('resolveInlineFunctionTools', () => {
  const inlineTool = {
    type: 'inline_function' as const,
    name: 'my_tool',
    config: {
      inlineFunction: {
        description: 'Does something',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  };

  it('includes inline function tool in renderConfig', () => {
    const ctx = baseContext({ tools: [inlineTool] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.inlineFunctionTools).toHaveLength(1);
    expect(renderConfig.inlineFunctionTools?.at(0)!.name).toBe('my_tool');
    expect(renderConfig.inlineFunctionTools?.at(0)!.description).toBe('Does something');
  });

  it('excludes inline tool filtered by allowedTools', () => {
    const ctx = baseContext({ tools: [inlineTool], allowedTools: ['other-tool'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.inlineFunctionTools).toHaveLength(0);
  });

  it('returns empty array when no inline tools', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.inlineFunctionTools).toHaveLength(0);
  });
});

// ============================================================================
// isBuiltinIncluded (shell / file_operations)
// ============================================================================

describe('isBuiltinIncluded (shell / file_operations)', () => {
  it('includes shell and file_operations when allowedTools is wildcard', () => {
    const ctx = baseContext({ allowedTools: ['*'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(true);
    expect(renderConfig.hasFileOperations).toBe(true);
  });

  it('includes shell and file_operations when allowedTools is unset (defaults to wildcard)', () => {
    const ctx = baseContext();
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(true);
    expect(renderConfig.hasFileOperations).toBe(true);
  });

  it('includes shell via @builtin pattern', () => {
    const ctx = baseContext({ allowedTools: ['@builtin'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(true);
    expect(renderConfig.hasFileOperations).toBe(true);
  });

  it('includes shell via @builtin/shell pattern', () => {
    const ctx = baseContext({ allowedTools: ['@builtin/shell'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(true);
    expect(renderConfig.hasFileOperations).toBe(false);
  });

  it('excludes both builtins when allowedTools only lists non-builtin tools', () => {
    const ctx = baseContext({ allowedTools: ['some-tool'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(false);
    expect(renderConfig.hasFileOperations).toBe(false);
  });

  it('plain "shell" name does not match the builtin/shell builtin', () => {
    // Only @builtin or @builtin/shell patterns match builtins, not plain tool names
    const ctx = baseContext({ allowedTools: ['shell'] });
    const { renderConfig } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(renderConfig.hasShell).toBe(false);
  });
});
