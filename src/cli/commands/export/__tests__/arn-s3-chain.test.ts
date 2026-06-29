import type { Harness } from '../../../aws/agentcore-harness';
import { mapApiHarnessToSpec } from '../fetch-harness-spec';
import { mapHarnessToExportConfig } from '../harness-mapper';
import type { ResolvedHarnessContext } from '../types';
import { describe, expect, it } from 'vitest';

/**
 * Regression for the --arn S3-skill gap found in live e2e: a harness fetched by ARN returns its
 * S3 skill in the control-plane shape `{ S3: { Uri } }`. The fetch mapper must normalize it to
 * `{ s3Uri }` so the export mapper's isS3Skill branch fires and generates the s3-skills policy
 * (otherwise S3 access is silently dropped for ARN-exported harnesses).
 */
describe('--arn export: S3 skill produces additionalPolicies', () => {
  it('generates s3-skills-policy.json from a fetched { S3: { Uri } } skill', () => {
    const apiHarness = {
      harnessId: 'h-1',
      harnessName: 'Fetched',
      arn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h-1',
      status: 'READY',
      executionRoleArn: 'arn:aws:iam::111122223333:role/r',
      model: { bedrockModelConfig: { modelId: 'anthropic.claude-3' } },
      skills: [{ S3: { Uri: 's3://fetched-bucket/skills/' } } as never],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as Harness;

    const { spec } = mapApiHarnessToSpec(apiHarness);
    const ctx: ResolvedHarnessContext = {
      harnessName: 'Fetched',
      targetAgentName: 'FetchedAgent',
      spec,
      systemPrompt: 'hi',
      projectSpec: { name: 'p', runtimes: [], memories: [], credentials: [], harnesses: [] } as never,
      deployedResources: null,
      configBaseDir: '/p/agentcore',
      projectRoot: '/p',
      exportNotes: [],
      region: 'us-east-1',
      localEnvVars: {},
      generatedPolicyFiles: {},
      additionalPolicies: [],
    };

    const { agentEnvSpec } = mapHarnessToExportConfig(ctx, 'CodeZip');
    expect(ctx.additionalPolicies).toContain('s3-skills-policy.json');
    expect(agentEnvSpec.additionalPolicies).toContain('s3-skills-policy.json');
    const doc = ctx.generatedPolicyFiles['s3-skills-policy.json'] as {
      Statement: { Action: string; Resource: string[] }[];
    };
    expect(doc.Statement.find(s => s.Action === 's3:GetObject')!.Resource).toContain(
      'arn:aws:s3:::fetched-bucket/skills/*'
    );
  });
});
