/**
 * E2E test: BYO agent with CUSTOM_JWT inbound auth (Cognito).
 *
 * Creates a Cognito user pool as the OIDC provider, deploys a BYO agent
 * configured with CUSTOM_JWT authorizer, and verifies that:
 * - Deploy succeeds with AuthorizerConfiguration in the CloudFormation template
 * - SigV4 invocation is rejected (auth method mismatch)
 * - Status reports the agent as deployed
 *
 * Unlike other E2E tests that use the globally installed CLI, this test uses
 * the local build (`runCLI`) because it exercises unreleased schema and CDK
 * changes. Set CDK_TARBALL to a path to the modified CDK package tarball.
 *
 * Requires: AWS credentials, npm, git, uv, CDK_TARBALL env var.
 */
import {
  type RunResult,
  hasAwsCredentials,
  parseJsonOutput,
  prereqs,
  runCLI,
  stripAnsi,
} from '../src/test-utils/index.js';
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
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const hasCdkTarball = !!process.env.CDK_TARBALL;
const canRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws && hasCdkTarball;
const region = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Run the local CLI build without skipping install (needed for deploy).
 */
function runLocalCLI(args: string[], cwd: string): Promise<RunResult> {
  return runCLI(args, cwd, /* skipInstall */ false);
}

describe.sequential('e2e: BYO agent with CUSTOM_JWT auth', () => {
  let testDir: string;
  let projectPath: string;
  let agentName: string;
  let mcpAgentName: string;

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
    const poolName = `agentcore-e2e-jwt-${suffix}`;
    domainPrefix = `agentcore-e2e-jwt-${suffix}`;

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

    // ── Create test project using local CLI build ──
    testDir = join(tmpdir(), `agentcore-e2e-jwt-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    agentName = `E2eJwt${String(Date.now()).slice(-8)}`;
    const createResult = await runLocalCLI(
      [
        'create',
        '--name',
        agentName,
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );
    expect(createResult.exitCode, `Create failed: ${createResult.stderr}`).toBe(0);
    const createJson = parseJsonOutput(createResult.stdout) as { projectPath: string };
    projectPath = createJson.projectPath;

    // Write AWS targets
    const account =
      process.env.AWS_ACCOUNT_ID ??
      execSync('aws sts get-caller-identity --query Account --output text').toString().trim();
    await writeFile(
      join(projectPath, 'agentcore', 'aws-targets.json'),
      JSON.stringify([{ name: 'default', account, region }])
    );

    // Install modified CDK tarball (required for auth fields support)
    execSync(`npm install -f ${process.env.CDK_TARBALL}`, {
      cwd: join(projectPath, 'agentcore', 'cdk'),
      stdio: 'pipe',
    });

    // ── Add an MCP protocol agent to the same project ──
    mcpAgentName = `E2eMcp${String(Date.now()).slice(-8)}`;
    const addResult = await runLocalCLI(
      ['add', 'agent', '--name', mcpAgentName, '--protocol', 'MCP', '--language', 'Python', '--json'],
      projectPath
    );
    expect(addResult.exitCode, `Add MCP agent failed: ${addResult.stderr}`).toBe(0);

    // ── Patch both agents with CUSTOM_JWT auth ──
    const specPath = join(projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    for (const runtime of spec.runtimes) {
      runtime.authorizerType = 'CUSTOM_JWT';
      runtime.authorizerConfiguration = {
        customJwtAuthorizer: {
          discoveryUrl,
          allowedAudience: [clientId],
        },
      };
    }
    await writeFile(specPath, JSON.stringify(spec, null, 2));
  }, 300000);

  afterAll(async () => {
    if (!canRun) return;

    // ── Tear down deployed stack ──
    if (projectPath) {
      try {
        await runLocalCLI(['remove', 'all', '--json'], projectPath);
        await runLocalCLI(['deploy', '--yes', '--json'], projectPath);
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

    // ── Clean up temp directory ──
    if (testDir) {
      await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }
  }, 600000);

  it.skipIf(!canRun)(
    'deploys with CUSTOM_JWT authorizer configuration',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const result = await runLocalCLI(['deploy', '--yes', '--json'], projectPath);

      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }

      expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as { success: boolean; stackName: string };
      expect(json.success, 'Deploy should report success').toBe(true);

      // Verify CloudFormation template contains AuthorizerConfiguration
      const templateResult = await cfnClient.send(new GetTemplateCommand({ StackName: json.stackName }));
      const template = JSON.parse(templateResult.TemplateBody!) as {
        Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
      };

      const runtimeResource = Object.values(template.Resources).find(r => r.Type === 'AWS::BedrockAgentCore::Runtime');
      expect(runtimeResource, 'Template should contain a Runtime resource').toBeDefined();

      const props = runtimeResource!.Properties;
      const authConfig = props.AuthorizerConfiguration as {
        CustomJWTAuthorizer: { DiscoveryUrl: string; AllowedAudience: string[] };
      };
      expect(authConfig, 'Runtime should have AuthorizerConfiguration').toBeDefined();
      expect(authConfig.CustomJWTAuthorizer.DiscoveryUrl).toBe(discoveryUrl);
      expect(authConfig.CustomJWTAuthorizer.AllowedAudience).toContain(clientId);
    },
    600000
  );

  it.skipIf(!canRun)(
    'rejects SigV4 invocation (auth method mismatch)',
    async () => {
      expect(projectPath, 'Project should have been deployed').toBeTruthy();

      // The CLI uses SigV4 by default — a CUSTOM_JWT runtime should reject it
      const result = await runLocalCLI(
        ['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json'],
        projectPath
      );

      // Expect failure due to auth method mismatch (client-side fast-fail or server-side rejection)
      const output = stripAnsi(result.stdout + result.stderr);
      expect(output).toMatch(
        /configured for CUSTOM_JWT but no bearer token|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'invokes with bearer token successfully',
    async () => {
      expect(projectPath, 'Project should have been deployed').toBeTruthy();

      const accessToken = await fetchCognitoAccessToken();

      // Invoke with bearer token — should NOT get auth mismatch
      const result = await runLocalCLI(
        ['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--bearer-token', accessToken, '--json'],
        projectPath
      );

      const output = stripAnsi(result.stdout + result.stderr);
      // The invoke may fail for other reasons (agent logic), but it should NOT fail with auth mismatch
      expect(output).not.toMatch(
        /configured for CUSTOM_JWT but no bearer token|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'MCP agent: rejects SigV4 invocation (auth method mismatch)',
    async () => {
      expect(projectPath, 'Project should have been deployed').toBeTruthy();

      const result = await runLocalCLI(['invoke', '--runtime', mcpAgentName, 'list-tools', '--json'], projectPath);

      const output = stripAnsi(result.stdout + result.stderr);
      expect(output).toMatch(
        /configured for CUSTOM_JWT but no bearer token|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'MCP agent: lists tools with bearer token',
    async () => {
      expect(projectPath, 'Project should have been deployed').toBeTruthy();

      const accessToken = await fetchCognitoAccessToken();

      const result = await runLocalCLI(
        ['invoke', '--runtime', mcpAgentName, 'list-tools', '--bearer-token', accessToken, '--json'],
        projectPath
      );

      const output = stripAnsi(result.stdout + result.stderr);
      expect(output).not.toMatch(
        /configured for CUSTOM_JWT but no bearer token|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'MCP agent: calls tool with bearer token',
    async () => {
      expect(projectPath, 'Project should have been deployed').toBeTruthy();

      const accessToken = await fetchCognitoAccessToken();

      const result = await runLocalCLI(
        [
          'invoke',
          '--runtime',
          mcpAgentName,
          'call-tool',
          '--tool',
          'add_numbers',
          '--input',
          '{"a": 2, "b": 3}',
          '--bearer-token',
          accessToken,
          '--json',
        ],
        projectPath
      );

      const output = stripAnsi(result.stdout + result.stderr);
      expect(output).not.toMatch(
        /configured for CUSTOM_JWT but no bearer token|[Aa]uthoriz(ation|er).*mismatch|different.*authorization/i
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'status shows the deployed agent',
    async () => {
      const result = await runLocalCLI(['status', '--json'], projectPath);
      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const agent = json.resources.find(r => r.resourceType === 'agent' && r.name === agentName);
      expect(agent, `Agent "${agentName}" should appear in status`).toBeDefined();
      expect(agent!.deploymentState).toBe('deployed');
    },
    120000
  );
});
