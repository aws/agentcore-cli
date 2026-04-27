/**
 * Import Evaluator Unit Tests
 *
 * Covers:
 * - toEvaluatorSpec conversion: LLM-as-a-Judge (numerical + categorical), code-based (external)
 * - Evaluator with description and tags
 * - Missing config error handling
 * - Template logical ID lookup for evaluators
 * - Phase 2 import resource list construction for evaluators
 * - ARN validation for evaluator resource type
 */
import type { GetEvaluatorResult } from '../../../aws/agentcore-control';
import { toEvaluatorSpec } from '../import-evaluator';
import { buildImportTemplate, findLogicalIdByProperty, findLogicalIdsByType } from '../template-utils';
import type { CfnTemplate } from '../template-utils';
import type { ResourceToImport } from '../types';
import { describe, expect, it } from 'vitest';

// ============================================================================
// toEvaluatorSpec Conversion Tests
// ============================================================================

describe('toEvaluatorSpec', () => {
  it('maps LLM-as-a-Judge evaluator with numerical rating scale', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-123',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-123',
      evaluatorName: 'my_evaluator',
      level: 'SESSION',
      status: 'ACTIVE',
      description: 'Test evaluator',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate the response quality',
          ratingScale: {
            numerical: [
              { value: 1, label: 'Poor', definition: 'Low quality response' },
              { value: 5, label: 'Excellent', definition: 'High quality response' },
            ],
          },
        },
      },
      tags: { env: 'test' },
    };

    const result = toEvaluatorSpec(detail, 'my_evaluator');

    expect(result.name).toBe('my_evaluator');
    expect(result.level).toBe('SESSION');
    expect(result.description).toBe('Test evaluator');
    expect(result.config.llmAsAJudge).toBeDefined();
    expect(result.config.llmAsAJudge!.model).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(result.config.llmAsAJudge!.instructions).toBe('Evaluate the response quality');
    expect(result.config.llmAsAJudge!.ratingScale.numerical).toHaveLength(2);
    expect(result.config.llmAsAJudge!.ratingScale.numerical![0]).toEqual({
      value: 1,
      label: 'Poor',
      definition: 'Low quality response',
    });
    expect(result.tags).toEqual({ env: 'test' });
  });

  it('maps LLM-as-a-Judge evaluator with categorical rating scale', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-456',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-456',
      evaluatorName: 'categorical_eval',
      level: 'TRACE',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Rate as pass or fail',
          ratingScale: {
            categorical: [
              { label: 'Pass', definition: 'Response meets criteria' },
              { label: 'Fail', definition: 'Response does not meet criteria' },
            ],
          },
        },
      },
    };

    const result = toEvaluatorSpec(detail, 'categorical_eval');

    expect(result.level).toBe('TRACE');
    expect(result.config.llmAsAJudge).toBeDefined();
    expect(result.config.llmAsAJudge!.ratingScale.categorical).toHaveLength(2);
    expect(result.config.llmAsAJudge!.ratingScale.categorical![0]).toEqual({
      label: 'Pass',
      definition: 'Response meets criteria',
    });
    // No description or tags
    expect(result.description).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it('maps code-based evaluator as external with Lambda ARN', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-code-789',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-code-789',
      evaluatorName: 'code_eval',
      level: 'TOOL_CALL',
      status: 'ACTIVE',
      evaluatorConfig: {
        codeBased: {
          lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:my-eval-function',
        },
      },
    };

    const result = toEvaluatorSpec(detail, 'code_eval');

    expect(result.name).toBe('code_eval');
    expect(result.level).toBe('TOOL_CALL');
    expect(result.config.codeBased).toBeDefined();
    expect(result.config.codeBased!.external).toBeDefined();
    expect(result.config.codeBased!.external!.lambdaArn).toBe(
      'arn:aws:lambda:us-west-2:123456789012:function:my-eval-function'
    );
    expect(result.config.llmAsAJudge).toBeUndefined();
  });

  it('uses provided local name instead of evaluator name from AWS', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-rename',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-rename',
      evaluatorName: 'original_name',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate',
          ratingScale: { numerical: [{ value: 1, label: 'Low', definition: 'Low' }] },
        },
      },
    };

    const result = toEvaluatorSpec(detail, 'custom_local_name');

    expect(result.name).toBe('custom_local_name');
  });

  it('throws when evaluator has no recognizable config', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-no-config',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-no-config',
      evaluatorName: 'broken_eval',
      level: 'SESSION',
      status: 'ACTIVE',
    };

    expect(() => toEvaluatorSpec(detail, 'broken_eval')).toThrow('Evaluator "broken_eval" has no recognizable config');
  });

  it('throws when evaluatorConfig is empty object', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-empty',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-empty',
      evaluatorName: 'empty_config_eval',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {},
    };

    expect(() => toEvaluatorSpec(detail, 'empty_config_eval')).toThrow('has no recognizable config');
  });

  it('omits description when not present', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-no-desc',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-no-desc',
      evaluatorName: 'no_desc_eval',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate',
          ratingScale: { numerical: [{ value: 1, label: 'Low', definition: 'Low' }] },
        },
      },
    };

    const result = toEvaluatorSpec(detail, 'no_desc_eval');

    expect(result.description).toBeUndefined();
  });

  it('omits tags when empty', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-empty-tags',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-empty-tags',
      evaluatorName: 'empty_tags_eval',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate',
          ratingScale: { numerical: [{ value: 1, label: 'Low', definition: 'Low' }] },
        },
      },
      tags: {},
    };

    const result = toEvaluatorSpec(detail, 'empty_tags_eval');

    expect(result.tags).toBeUndefined();
  });

  it('forwards kmsKeyArn when present', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-kms',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-kms',
      evaluatorName: 'kms_eval',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate',
          ratingScale: { numerical: [{ value: 1, label: 'Low', definition: 'Low' }] },
        },
      },
      kmsKeyArn: 'arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012',
    };

    const result = toEvaluatorSpec(detail, 'kms_eval');

    expect(result.kmsKeyArn).toBe('arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012');
  });

  it('omits kmsKeyArn when not present', () => {
    const detail: GetEvaluatorResult = {
      evaluatorId: 'eval-no-kms',
      evaluatorArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-no-kms',
      evaluatorName: 'no_kms_eval',
      level: 'SESSION',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          instructions: 'Evaluate',
          ratingScale: { numerical: [{ value: 1, label: 'Low', definition: 'Low' }] },
        },
      },
    };

    const result = toEvaluatorSpec(detail, 'no_kms_eval');

    expect(result.kmsKeyArn).toBeUndefined();
  });
});

// ============================================================================
// Template Logical ID Lookup Tests for Evaluators
// ============================================================================

describe('Template Logical ID Lookup for Evaluators', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      MyEvaluatorResource: {
        Type: 'AWS::BedrockAgentCore::Evaluator',
        Properties: {
          EvaluatorName: 'my_evaluator',
          Level: 'SESSION',
        },
      },
      PrefixedEvaluatorResource: {
        Type: 'AWS::BedrockAgentCore::Evaluator',
        Properties: {
          EvaluatorName: 'TestProject_prefixed_eval',
          Level: 'TRACE',
        },
      },
      MyAgentRuntime: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: {
          AgentRuntimeName: 'TestProject_my_agent',
        },
      },
      MyIAMRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: 'MyRole',
        },
      },
    },
  };

  it('finds evaluator logical ID by EvaluatorName property', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      'my_evaluator'
    );
    expect(logicalId).toBe('MyEvaluatorResource');
  });

  it('finds prefixed evaluator by full name', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      'TestProject_prefixed_eval'
    );
    expect(logicalId).toBe('PrefixedEvaluatorResource');
  });

  it('finds all evaluator logical IDs by type', () => {
    const logicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Evaluator');
    expect(logicalIds).toHaveLength(2);
    expect(logicalIds).toContain('MyEvaluatorResource');
    expect(logicalIds).toContain('PrefixedEvaluatorResource');
  });

  it('returns undefined for non-existent evaluator name', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      'nonexistent_evaluator'
    );
    expect(logicalId).toBeUndefined();
  });

  it('falls back to single evaluator logical ID when name does not match', () => {
    const singleEvalTemplate: CfnTemplate = {
      Resources: {
        OnlyEvaluator: {
          Type: 'AWS::BedrockAgentCore::Evaluator',
          Properties: {
            EvaluatorName: 'some_eval',
            Level: 'SESSION',
          },
        },
      },
    };

    let logicalId = findLogicalIdByProperty(
      singleEvalTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      'different_name'
    );

    // Primary lookup fails
    expect(logicalId).toBeUndefined();

    // Fallback: if there's only one evaluator resource, use it
    if (!logicalId) {
      const evaluatorLogicalIds = findLogicalIdsByType(singleEvalTemplate, 'AWS::BedrockAgentCore::Evaluator');
      if (evaluatorLogicalIds.length === 1) {
        logicalId = evaluatorLogicalIds[0];
      }
    }
    expect(logicalId).toBe('OnlyEvaluator');
  });
});

// ============================================================================
// Phase 2 Resource Import List Construction for Evaluators
// ============================================================================

describe('Phase 2: ResourceToImport List Construction for Evaluators', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      EvaluatorLogicalId: {
        Type: 'AWS::BedrockAgentCore::Evaluator',
        Properties: {
          EvaluatorName: 'my_evaluator',
          Level: 'SESSION',
        },
      },
      IAMRoleLogicalId: {
        Type: 'AWS::IAM::Role',
        Properties: {},
      },
    },
  };

  it('builds ResourceToImport list for evaluator', () => {
    const evaluatorName = 'my_evaluator';
    const evaluatorId = 'eval-123';

    const resourcesToImport: ResourceToImport[] = [];

    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      evaluatorName
    );

    if (logicalId) {
      resourcesToImport.push({
        resourceType: 'AWS::BedrockAgentCore::Evaluator',
        logicalResourceId: logicalId,
        resourceIdentifier: { EvaluatorId: evaluatorId },
      });
    }

    expect(resourcesToImport).toHaveLength(1);
    expect(resourcesToImport[0]!.resourceType).toBe('AWS::BedrockAgentCore::Evaluator');
    expect(resourcesToImport[0]!.logicalResourceId).toBe('EvaluatorLogicalId');
    expect(resourcesToImport[0]!.resourceIdentifier).toEqual({ EvaluatorId: 'eval-123' });
  });

  it('returns empty list when evaluator not found in template', () => {
    const emptyTemplate: CfnTemplate = {
      Resources: {
        IAMRoleLogicalId: {
          Type: 'AWS::IAM::Role',
          Properties: {},
        },
      },
    };

    const logicalId = findLogicalIdByProperty(
      emptyTemplate,
      'AWS::BedrockAgentCore::Evaluator',
      'EvaluatorName',
      'my_evaluator'
    );

    expect(logicalId).toBeUndefined();
  });
});

// ============================================================================
// buildImportTemplate Tests for Evaluator Resources
// ============================================================================

describe('buildImportTemplate with Evaluator', () => {
  it('adds evaluator resource to deployed template with Retain deletion policy', () => {
    const deployedTemplate: CfnTemplate = {
      Resources: {
        ExistingIAMRole: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'ExistingRole' },
        },
      },
    };

    const synthTemplate: CfnTemplate = {
      Resources: {
        ExistingIAMRole: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'ExistingRole' },
        },
        EvaluatorLogicalId: {
          Type: 'AWS::BedrockAgentCore::Evaluator',
          Properties: {
            EvaluatorName: 'my_evaluator',
            Level: 'SESSION',
          },
          DependsOn: 'ExistingIAMRole',
        },
      },
    };

    const importTemplate = buildImportTemplate(deployedTemplate, synthTemplate, ['EvaluatorLogicalId']);

    // Verify evaluator resource was added
    expect(importTemplate.Resources.EvaluatorLogicalId).toBeDefined();
    expect(importTemplate.Resources.EvaluatorLogicalId!.Type).toBe('AWS::BedrockAgentCore::Evaluator');
    expect(importTemplate.Resources.EvaluatorLogicalId!.DeletionPolicy).toBe('Retain');
    expect(importTemplate.Resources.EvaluatorLogicalId!.UpdateReplacePolicy).toBe('Retain');

    // DependsOn should be removed for import
    expect(importTemplate.Resources.EvaluatorLogicalId!.DependsOn).toBeUndefined();

    // Original resource should still be there
    expect(importTemplate.Resources.ExistingIAMRole).toBeDefined();
  });
});
