/**
 * E2E test: a harness with CUSTOM_JWT inbound auth (Cognito).
 *
 * Creates a Cognito user pool as the OIDC provider, deploys a harness configured with a
 * CUSTOM_JWT authorizer, and verifies that:
 * - Deploy embeds AuthorizerConfiguration in the CloudFormation template
 * - A default SigV4 invocation is rejected (auth method mismatch)
 * - A bearer-token invocation is not rejected for auth reasons
 * - Status reports the harness as deployed
 *
 * `create` exposes no authorizer flags for the harness path, so the authorizer is written
 * into harness.json after create (mirrors byo-custom-jwt.test.ts patching agentcore.json).
 *
 * Requires: AWS credentials, npm, git.
 */
import { hasAwsCredentials, parseJsonOutput, prereqs, runCLI, stripAnsi } from '../src/test-utils/index.js';
import { installCdkTarball, writeAwsTargets } from './e2e-helper.js';
import { CloudFormationClient, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  CreateResourceServerCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DeleteResourceServerCommand,
  DeleteUserPoolCommand,
  DeleteUserPoolDomainCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const canRun = prereqs.npm && prereqs.git && hasAws;
const region = process.env.AWS_REGION ?? 'us-east-1';
const customJWTRejectMsgRegex = /configured for CUSTOM_JWT|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i;

describe.sequential('e2e: harness with CUSTOM_JWT auth', () => {
  let testDir: string;
  let projectPath: string;
  let harnessName: string;

  // Cognito resources
  let userPoolId: string;
  let clientId: string;
  let clientSecret: string;
  let domainPrefix: string;
  let discoveryUrl: string;

  const cognitoClient = new CognitoIdentityProviderClient({ region });
  const cfnClient = new CloudFormationClient({ region });

  /** Fetch a Cognito access token via client_credentials flow. */
  async function fetchCognitoAccessToken(): Promise<string> {
    const tokenUrl = `https://${domainPrefix}.auth.${region}.amazoncognito.com/oauth2/token`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials&scope=agentcore/invoke',
    });
    expect(tokenRes.ok, `Token fetch failed: ${tokenRes.status}`).toBe(true);
    const tokenJson = (await tokenRes.json()) as { access_token: string };
    expect(tokenJson.access_token, 'Should have received an access token').toBeTruthy();
    return tokenJson.access_token;
  }

  beforeAll(async () => {
    if (!canRun) return;

    // ── Create Cognito user pool as OIDC provider ──
    const suffix = randomUUID().slice(0, 8);
    const poolName = `agentcore-e2e-hrns-jwt-${suffix}`;
    domainPrefix = `agentcore-e2e-hrns-jwt-${suffix}`;

    const poolResult = await cognitoClient.send(new CreateUserPoolCommand({ PoolName: poolName }));
    userPoolId = poolResult.UserPool!.Id!;

    await cognitoClient.send(new CreateUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: domainPrefix }));

    await cognitoClient.send(
      new CreateResourceServerCommand({
        UserPoolId: userPoolId,
        Identifier: 'agentcore',
        Name: 'AgentCore API',
        Scopes: [{ ScopeName: 'invoke', ScopeDescription: 'Invoke the runtime' }],
      })
    );

    const clientResult = await cognitoClient.send(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: 'e2e-test-client',
        GenerateSecret: true,
        AllowedOAuthFlows: ['client_credentials'],
        AllowedOAuthScopes: ['agentcore/invoke'],
        AllowedOAuthFlowsUserPoolClient: true,
        ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      })
    );
    clientId = clientResult.UserPoolClient!.ClientId!;
    clientSecret = clientResult.UserPoolClient!.ClientSecret!;

    discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    // ── Create harness project using local CLI build ──
    testDir = join(tmpdir(), `agentcore-e2e-hrns-jwt-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    harnessName = `E2eHrnsJwt${String(Date.now()).slice(-8)}`;
    const createResult = await runCLI(
      ['create', '--name', harnessName, '--model-provider', 'bedrock', '--no-harness-memory', '--json', '--skip-git'],
      testDir,
      { skipInstall: false }
    );
    expect(createResult.exitCode, `Create failed: ${createResult.stderr}`).toBe(0);
    const createJson = parseJsonOutput(createResult.stdout) as { projectPath: string };
    projectPath = createJson.projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);

    // ── Patch the harness with CUSTOM_JWT auth ──
    const specPath = join(projectPath, 'app', harnessName, 'harness.json');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    spec.authorizerType = 'CUSTOM_JWT';
    spec.authorizerConfiguration = {
      customJwtAuthorizer: {
        discoveryUrl,
        allowedAudience: [clientId],
      },
    };
    await writeFile(specPath, JSON.stringify(spec, null, 2));
  }, 300000);

  afterAll(async () => {
    if (!canRun) return;

    // ── Tear down deployed stack ──
    if (projectPath) {
      try {
        await runCLI(['remove', 'all', '--json'], projectPath, { skipInstall: false });
        await runCLI(['deploy', '--yes', '--json'], projectPath, { skipInstall: false });
      } catch {
        // Best-effort cleanup
      }
    }

    // ── Delete Cognito resources ──
    if (userPoolId) {
      try {
        await cognitoClient.send(new DeleteResourceServerCommand({ UserPoolId: userPoolId, Identifier: 'agentcore' }));
      } catch {
        /* best-effort */
      }
      try {
        await cognitoClient.send(new DeleteUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: domainPrefix }));
      } catch {
        /* best-effort */
      }
      try {
        await cognitoClient.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }));
      } catch {
        /* best-effort */
      }
    }

    if (testDir) {
      await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }
  }, 600000);

  it.skipIf(!canRun)(
    'deploys with CUSTOM_JWT authorizer configuration',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runCLI(['deploy', '--yes', '--json'], projectPath, { skipInstall: false });

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }
      expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as { success: boolean; stackName: string };
      expect(json.success, 'Deploy should report success').toBe(true);

      // Verify the CloudFormation template carries the harness AuthorizerConfiguration.
      const templateResult = await cfnClient.send(new GetTemplateCommand({ StackName: json.stackName }));
      const template = JSON.parse(templateResult.TemplateBody!) as {
        Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
      };

      const harnessResource = Object.values(template.Resources).find(r => r.Type === 'AWS::BedrockAgentCore::Harness');
      expect(harnessResource, 'Template should contain a Harness resource').toBeDefined();

      const authConfig = harnessResource!.Properties.AuthorizerConfiguration as {
        CustomJWTAuthorizer: { DiscoveryUrl: string; AllowedAudience: string[] };
      };
      expect(authConfig, 'Harness should have AuthorizerConfiguration').toBeDefined();
      expect(authConfig.CustomJWTAuthorizer.DiscoveryUrl).toBe(discoveryUrl);
      expect(authConfig.CustomJWTAuthorizer.AllowedAudience).toContain(clientId);
    },
    600000
  );

  it.skipIf(!canRun)(
    'rejects SigV4 invocation (auth method mismatch)',
    async () => {
      // The CLI uses SigV4 by default — a CUSTOM_JWT harness should reject it.
      const result = await runCLI(
        ['invoke', '--harness', harnessName, '--prompt', 'Say hello', '--json'],
        projectPath,
        { skipInstall: false }
      );

      const output = stripAnsi(result.stdout + result.stderr);
      expect(result.exitCode, `failure: stderr=${result.stderr}\n\nstdout=${result.stdout}`).not.toBe(0);
      expect(output).toMatch(customJWTRejectMsgRegex);
    },
    180000
  );

  it.skipIf(!canRun)(
    'invokes with bearer token successfully',
    async () => {
      const accessToken = await fetchCognitoAccessToken();

      const result = await runCLI(
        ['invoke', '--harness', harnessName, '--prompt', 'Say hello', '--bearer-token', accessToken, '--json'],
        projectPath,
        { skipInstall: false }
      );

      const output = stripAnsi(result.stdout + result.stderr);
      // May still fail for unrelated reasons, but NOT with an auth-method mismatch.
      expect(output).not.toMatch(customJWTRejectMsgRegex);
    },
    180000
  );

  it.skipIf(!canRun)(
    'status shows the deployed harness',
    async () => {
      const result = await runCLI(['status', '--json'], projectPath, { skipInstall: false });
      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const harness = json.resources.find(r => r.resourceType === 'harness' && r.name === harnessName);
      expect(harness, `Harness "${harnessName}" should appear in status`).toBeDefined();
      expect(harness!.deploymentState).toBe('deployed');
    },
    120000
  );
});
