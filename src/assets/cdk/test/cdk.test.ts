import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

const originalCwd = process.cwd();
const originalInitCwd = process.env.INIT_CWD;
const testRoot = mkdtempSync(join(tmpdir(), 'agentcore-cdk-test-'));
const testConfigDir = join(testRoot, 'agentcore');
let AgentCoreStack: typeof import('../lib/cdk-stack').AgentCoreStack;

beforeAll(async () => {
  process.chdir(testRoot);
  process.env.INIT_CWD = testRoot;
  mkdirSync(testConfigDir, { recursive: true });
  writeFileSync(join(testConfigDir, 'agentcore.json'), '{}');
  ({ AgentCoreStack } = await import('../lib/cdk-stack'));
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = originalInitCwd;
  rmSync(testRoot, { recursive: true, force: true });
});

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});

test('AgentCoreStack synthesizes manual and Quick Create payment connectors', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [
        {
          authorizerType: 'PaymentCredentialProvider',
          name: 'coinbase',
          provider: 'CoinbaseCDP',
        },
      ],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [
        {
          name: 'Payments',
          authorizerType: 'AWS_IAM',
          connectors: [
            {
              name: 'Manual',
              provider: 'CoinbaseCDP',
              credentialName: 'coinbase',
            },
            {
              name: 'Quick',
              provider: 'CoinbaseCDP',
              provisionMode: 'QUICK_CREATE',
            },
          ],
        },
      ],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
    credentials: {
      coinbase: {
        credentialProviderArn:
          'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/paymentcredentialprovider/coinbase',
      },
    },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::BedrockAgentCore::PaymentConnector', 2);
  template.hasResourceProperties('AWS::BedrockAgentCore::PaymentConnector', {
    ConnectorName: 'Manual',
    ProvisionMode: Match.absent(),
  });
  template.hasResourceProperties('AWS::BedrockAgentCore::PaymentConnector', {
    ConnectorName: 'Quick',
    ConnectorType: 'CoinbaseCDP',
    ProvisionMode: 'QUICK_CREATE',
    CredentialProviderConfigurations: [],
  });
});
