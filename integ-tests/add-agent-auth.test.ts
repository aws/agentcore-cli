import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: add BYO agent with CUSTOM_JWT auth', () => {
  let project: TestProject;
  const agentName = 'AuthAgent';
  const discoveryUrl = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test123/.well-known/openid-configuration';

  beforeAll(async () => {
    project = await createTestProject({
      noAgent: true,
    });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds a BYO agent with CUSTOM_JWT authorizer and audience', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentName,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agentName}`,
        '--authorizer-type',
        'CUSTOM_JWT',
        '--discovery-url',
        discoveryUrl,
        '--allowed-audience',
        'aud1,aud2',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.agentName).toBe(agentName);

    // Verify config has authorizer fields
    const config = await readProjectConfig(project.projectPath);
    const agent = config.agents.find(a => a.name === agentName);
    expect(agent, `Agent "${agentName}" should be in config`).toBeTruthy();
    expect(agent!.authorizerType).toBe('CUSTOM_JWT');
    expect(agent!.authorizerConfiguration).toBeDefined();
    expect(agent!.authorizerConfiguration!.customJwtAuthorizer).toBeDefined();

    const jwt = agent!.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt.discoveryUrl).toBe(discoveryUrl);
    expect(jwt.allowedAudience).toEqual(['aud1', 'aud2']);
  });

  it('adds a second BYO agent with CUSTOM_JWT, clients, scopes, and client credentials', async () => {
    const agent2 = 'AuthAgent2';
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agent2,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agent2}`,
        '--authorizer-type',
        'CUSTOM_JWT',
        '--discovery-url',
        discoveryUrl,
        '--allowed-clients',
        'client-abc,client-def',
        '--allowed-scopes',
        'read,write',
        '--client-id',
        'my-client-id',
        '--client-secret',
        'my-client-secret',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const agent = config.agents.find(a => a.name === agent2);
    expect(agent).toBeTruthy();
    expect(agent!.authorizerType).toBe('CUSTOM_JWT');

    const jwt = agent!.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt.allowedClients).toEqual(['client-abc', 'client-def']);
    expect(jwt.allowedScopes).toEqual(['read', 'write']);

    // Verify OAuth credential was auto-created
    const oauthCred = config.credentials.find(c => c.name === `${agent2}-oauth`);
    expect(oauthCred, 'OAuth credential should be auto-created').toBeTruthy();
    expect(oauthCred!.authorizerType).toBe('OAuthCredentialProvider');
    expect((oauthCred as { managed?: boolean }).managed).toBe(true);

    // Verify .env.local has client secrets (namespaced per credential)
    const envPath = join(project.projectPath, 'agentcore', '.env.local');
    const envContent = await readFile(envPath, 'utf-8');
    expect(envContent).toContain('my-client-id');
    expect(envContent).toContain('my-client-secret');
  });

  it('adds a BYO agent with default AWS_IAM auth (no auth flags)', async () => {
    const agent3 = 'IamAgent';
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agent3,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agent3}`,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const config = await readProjectConfig(project.projectPath);
    const agent = config.agents.find(a => a.name === agent3);
    expect(agent).toBeTruthy();
    // No authorizerType means AWS_IAM default
    expect(agent!.authorizerType).toBeUndefined();
    expect(agent!.authorizerConfiguration).toBeUndefined();
  });

  it('rejects CUSTOM_JWT without discovery URL', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'BadAuth',
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        'apps/BadAuth',
        '--authorizer-type',
        'CUSTOM_JWT',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects CUSTOM_JWT without any constraint', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'NoConstraint',
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        'apps/NoConstraint',
        '--authorizer-type',
        'CUSTOM_JWT',
        '--discovery-url',
        discoveryUrl,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('rejects client credentials without CUSTOM_JWT', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'BadCreds',
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        'apps/BadCreds',
        '--client-id',
        'some-id',
        '--client-secret',
        'some-secret',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('adds a BYO agent with custom claims', async () => {
    const agent4 = 'ClaimsAgent';
    const customClaims = JSON.stringify([
      {
        inboundTokenClaimName: 'department',
        inboundTokenClaimValueType: 'STRING',
        authorizingClaimMatchValue: {
          claimMatchOperator: 'EQUALS',
          claimMatchValue: { matchValueString: 'engineering' },
        },
      },
    ]);
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agent4,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agent4}`,
        '--authorizer-type',
        'CUSTOM_JWT',
        '--discovery-url',
        discoveryUrl,
        '--custom-claims',
        customClaims,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

    const config = await readProjectConfig(project.projectPath);
    const agent = config.agents.find(a => a.name === agent4);
    expect(agent).toBeTruthy();

    const jwt = agent!.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt.customClaims).toBeDefined();
    expect(jwt.customClaims).toHaveLength(1);
    expect(jwt.customClaims![0]!.inboundTokenClaimName).toBe('department');
  });
});
