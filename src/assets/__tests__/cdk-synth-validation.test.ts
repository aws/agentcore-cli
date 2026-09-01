/**
 * CDK Synthesis Validation Tests
 *
 * Validates that realistic agentcore.json configurations can be synthesized
 * into valid CloudFormation templates by the vended CDK stack.
 *
 * These tests catch schema mismatches and construct bugs before deploy time.
 */
import { AgentCoreStack } from '../cdk/lib/cdk-stack';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import type { AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── CFN Resource Types ──────────────────────────────────────────────────────

const CFN_RUNTIME = 'AWS::BedrockAgentCore::Runtime';
const CFN_MEMORY = 'AWS::BedrockAgentCore::Memory';
const CFN_EVALUATOR = 'AWS::BedrockAgentCore::Evaluator';
const CFN_POLICY_ENGINE = 'AWS::BedrockAgentCore::PolicyEngine';
const CFN_POLICY = 'AWS::BedrockAgentCore::Policy';
const CFN_ECR_REPO = 'AWS::ECR::Repository';
const CFN_CODEBUILD = 'AWS::CodeBuild::Project';
const CFN_IAM_ROLE = 'AWS::IAM::Role';

// ─── Test project directory ──────────────────────────────────────────────────
// AgentCoreApplication calls findConfigRoot() which walks up from cwd looking
// for agentcore/agentcore.json. We use setSessionProjectRoot() to point it at
// our temp directory instead of mutating process.cwd().

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentcore-cdk-synth-test-'));
  const agentcoreDir = join(tmpDir, 'agentcore');
  mkdirSync(agentcoreDir, { recursive: true });
  // Create minimal agentcore.json so findConfigRoot() succeeds
  writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
  // Create agent code directories that constructs may reference
  const agentNames = [
    'myagent',
    'agent1',
    'agent2',
    'primaryagent',
    'secondaryagent',
    'containeragent',
    'mcpagent',
    'a2aagent',
    'a'.repeat(48),
  ];
  const minimalPyproject = '[project]\nname = "agent"\nversion = "0.1.0"\n';
  for (const dir of agentNames) {
    mkdirSync(join(tmpDir, 'agents', dir), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', dir, 'main.py'), '# placeholder');
    writeFileSync(join(tmpDir, 'agents', dir, 'pyproject.toml'), minimalPyproject);
    writeFileSync(join(tmpDir, 'agents', dir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  }
  // Tell the CDK L3 construct where the project root is
  setSessionProjectRoot(tmpDir);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function synthStack(
  spec: AgentCoreProjectSpec,
  mcpSpec?: AgentCoreProjectSpec['agentCoreGateways'],
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>
): Template {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, `TestStack${Date.now()}`, {
    spec,
    mcpSpec: mcpSpec ? { agentCoreGateways: mcpSpec } : undefined,
    credentials,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

function baseSpec(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'testproject',
    version: 1,
    managedBy: 'CDK',
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    policyEngines: [],
    agentCoreGateways: [],
    ...overrides,
  };
}

function makeRuntime(
  name: string,
  overrides: Partial<AgentCoreProjectSpec['runtimes'][number]> = {}
): AgentCoreProjectSpec['runtimes'][number] {
  return {
    name,
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: `agents/${name}`,
    runtimeVersion: 'PYTHON_3_12',
    ...overrides,
  };
}

function makeMemory(
  name: string,
  strategies: AgentCoreProjectSpec['memories'][number]['strategies'] = []
): AgentCoreProjectSpec['memories'][number] {
  return {
    name,
    eventExpiryDuration: 30,
    strategies,
  };
}

function makeEvaluator(name: string): AgentCoreProjectSpec['evaluators'][number] {
  return {
    name,
    level: 'SESSION',
    config: {
      llmAsAJudge: {
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        instructions: 'Rate the response quality based on helpfulness and accuracy.',
        ratingScale: {
          numerical: [
            { value: 1, label: 'Poor', definition: 'Unhelpful or incorrect' },
            { value: 3, label: 'Good', definition: 'Mostly helpful and accurate' },
            { value: 5, label: 'Excellent', definition: 'Very helpful and fully accurate' },
          ],
        },
      },
    },
  };
}

function makeOnlineEvalConfig(
  name: string,
  agent: string,
  evaluators: string[]
): AgentCoreProjectSpec['onlineEvalConfigs'][number] {
  return {
    name,
    agent,
    evaluators,
    samplingRate: 50,
  };
}

function makeCredential(
  name: string,
  authorizerType: 'ApiKeyCredentialProvider' | 'OAuthCredentialProvider' = 'ApiKeyCredentialProvider'
): AgentCoreProjectSpec['credentials'][number] {
  if (authorizerType === 'OAuthCredentialProvider') {
    return {
      authorizerType,
      name,
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      scopes: ['openid'],
    };
  }
  return { authorizerType, name };
}

function makePolicyEngine(name: string): AgentCoreProjectSpec['policyEngines'][number] {
  return {
    name,
    policies: [
      {
        name: `${name}Policy`,
        statement: 'permit(principal, action, resource);',
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CDK Synthesis Validation', () => {
  // ─── Empty and minimal specs ──────────────────────────────────────────────

  it('synthesizes empty spec with only StackNameOutput', () => {
    const template = synthStack(baseSpec());
    template.hasOutput('StackNameOutput', {
      Description: 'Name of the CloudFormation Stack',
    });
  });

  // ─── Agent specs ──────────────────────────────────────────────────────────

  it('synthesizes a single CodeZip agent', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });

    template.hasResourceProperties(CFN_IAM_ROLE, {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: Match.objectLike({
              Service: Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  it('synthesizes a Container agent with ECR and CodeBuild', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('containeragent', { build: 'Container' })],
      })
    );

    template.hasResourceProperties(CFN_ECR_REPO, {
      RepositoryName: Match.stringLikeRegexp('containeragent'),
    });

    template.hasResourceProperties(CFN_CODEBUILD, {
      Source: Match.objectLike({
        Type: Match.anyValue(),
      }),
    });
  });

  it('synthesizes multiple agents', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('agent1'), makeRuntime('agent2')],
      })
    );

    template.resourceCountIs(CFN_RUNTIME, 2);
  });

  // ─── Memory specs ─────────────────────────────────────────────────────────

  it('synthesizes agent with short-term memory (no strategies)', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        memories: [makeMemory('ShortTermMem')],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('ShortTermMem'),
    });
  });

  it('synthesizes agent with long-term memory strategies', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        memories: [
          makeMemory('LongTermMem', [{ type: 'SEMANTIC' }, { type: 'SUMMARIZATION' }, { type: 'USER_PREFERENCE' }]),
        ],
      })
    );

    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('LongTermMem'),
    });
  });

  // ─── Credential specs ─────────────────────────────────────────────────────

  it('synthesizes agent with API key credential', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        credentials: [makeCredential('MyApiKey')],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
  });

  it('synthesizes agent with OAuth credential', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        credentials: [makeCredential('MyOAuth', 'OAuthCredentialProvider')],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
  });

  // ─── Evaluator specs ──────────────────────────────────────────────────────

  it('synthesizes custom evaluator', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        evaluators: [makeEvaluator('QualityCheck')],
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, {
      EvaluatorName: Match.stringLikeRegexp('QualityCheck'),
    });
  });

  // ─── Online eval config specs ─────────────────────────────────────────────

  it('synthesizes online eval config referencing project agent', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        evaluators: [makeEvaluator('QualityCheck')],
        onlineEvalConfigs: [makeOnlineEvalConfig('MonitorQuality', 'myagent', ['QualityCheck'])],
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, {
      EvaluatorName: Match.stringLikeRegexp('QualityCheck'),
    });
  });

  it('synthesizes online eval config with builtin evaluator', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        onlineEvalConfigs: [makeOnlineEvalConfig('BuiltinMonitor', 'myagent', ['Builtin.GoalSuccessRate'])],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
  });

  // ─── Policy engine specs ──────────────────────────────────────────────────

  it('synthesizes policy engine', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        policyEngines: [makePolicyEngine('SafetyGuard')],
      })
    );

    template.hasResourceProperties(CFN_POLICY_ENGINE, {
      Name: Match.stringLikeRegexp('SafetyGuard'),
    });
    template.hasResourceProperties(CFN_POLICY, {
      Definition: Match.objectLike({
        Cedar: Match.objectLike({
          Statement: Match.stringLikeRegexp('permit'),
        }),
      }),
    });
  });

  // ─── Full project specs ───────────────────────────────────────────────────

  it('synthesizes a complete project with all resource types', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('primaryagent'), makeRuntime('secondaryagent')],
        memories: [makeMemory('ProjectMemory', [{ type: 'SEMANTIC' }])],
        credentials: [makeCredential('ProdApiKey'), makeCredential('OAuthProvider', 'OAuthCredentialProvider')],
        evaluators: [makeEvaluator('ResponseQuality')],
        onlineEvalConfigs: [
          makeOnlineEvalConfig('LiveMonitor', 'primaryagent', ['Builtin.GoalSuccessRate', 'ResponseQuality']),
        ],
        policyEngines: [makePolicyEngine('ContentFilter')],
      })
    );

    template.resourceCountIs(CFN_RUNTIME, 2);
    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('ProjectMemory'),
    });
    template.hasResourceProperties(CFN_EVALUATOR, {
      EvaluatorName: Match.stringLikeRegexp('ResponseQuality'),
    });
    template.hasResourceProperties(CFN_POLICY_ENGINE, {
      Name: Match.stringLikeRegexp('ContentFilter'),
    });
  });

  // ─── Agent configuration variants ─────────────────────────────────────────

  it('synthesizes agent with custom environment variables', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [
          makeRuntime('myagent', {
            envVars: [
              { name: 'MODEL_ID', value: 'anthropic.claude-3-haiku-20240307-v1:0' },
              { name: 'TEMPERATURE', value: '0.7' },
            ],
          }),
        ],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
  });

  it('synthesizes agent with MCP protocol', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('mcpagent', { protocol: 'MCP' })],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('mcpagent'),
    });
  });

  it('synthesizes agent with A2A protocol', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('a2aagent', { protocol: 'A2A' })],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('a2aagent'),
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('synthesizes with memories but no agents', () => {
    const template = synthStack(
      baseSpec({
        memories: [makeMemory('StandaloneMemory')],
      })
    );

    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('StandaloneMemory'),
    });
    template.resourceCountIs(CFN_RUNTIME, 0);
  });

  it('synthesizes with evaluators but no online eval configs', () => {
    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime('myagent')],
        evaluators: [makeEvaluator('UnusedEval')],
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, {
      EvaluatorName: Match.stringLikeRegexp('UnusedEval'),
    });
  });

  it('synthesizes spec with maximum name lengths', () => {
    const longAgentName = 'a'.repeat(48);
    const longMemoryName = 'M'.repeat(48);

    const template = synthStack(
      baseSpec({
        runtimes: [makeRuntime(longAgentName)],
        memories: [makeMemory(longMemoryName)],
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp(longAgentName),
    });
    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp(longMemoryName),
    });
  });
});
