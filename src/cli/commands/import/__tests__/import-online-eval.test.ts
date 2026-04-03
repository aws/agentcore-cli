/**
 * Import Online Eval Config Unit Tests
 *
 * Covers:
 * - extractAgentName: service name parsing
 * - toOnlineEvalConfigSpec conversion: happy path, missing sampling, enableOnCreate
 * - Template logical ID lookup for online eval configs
 * - Phase 2 import resource list construction for online eval configs
 */
import type { GetOnlineEvalConfigResult } from '../../../aws/agentcore-control';
import { extractAgentName, toOnlineEvalConfigSpec } from '../import-online-eval';
import { buildImportTemplate, findLogicalIdByProperty, findLogicalIdsByType } from '../template-utils';
import type { CfnTemplate } from '../template-utils';
import type { ResourceToImport } from '../types';
import { describe, expect, it } from 'vitest';

// ============================================================================
// extractAgentName Tests
// ============================================================================

describe('extractAgentName', () => {
  it('extracts agent name from service name with .DEFAULT suffix', () => {
    expect(extractAgentName(['my_agent.DEFAULT'])).toBe('my_agent');
  });

  it('extracts agent name with project prefix pattern', () => {
    expect(extractAgentName(['testproject_my_agent.DEFAULT'])).toBe('testproject_my_agent');
  });

  it('returns full string when no dot suffix', () => {
    expect(extractAgentName(['my_agent'])).toBe('my_agent');
  });

  it('returns undefined for empty array', () => {
    expect(extractAgentName([])).toBeUndefined();
  });

  it('uses first service name when multiple provided', () => {
    expect(extractAgentName(['agent_one.DEFAULT', 'agent_two.DEFAULT'])).toBe('agent_one');
  });

  it('handles service name with multiple dots', () => {
    expect(extractAgentName(['my.agent.DEFAULT'])).toBe('my.agent');
  });
});

// ============================================================================
// toOnlineEvalConfigSpec Conversion Tests
// ============================================================================

describe('toOnlineEvalConfigSpec', () => {
  it('maps online eval config with all fields', () => {
    const detail: GetOnlineEvalConfigResult = {
      configId: 'oec-123',
      configArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/oec-123',
      configName: 'QualityMonitor',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      description: 'Monitor agent quality',
      samplingPercentage: 50,
      serviceNames: ['my_agent.DEFAULT'],
      evaluatorIds: ['eval-456'],
    };

    const result = toOnlineEvalConfigSpec(detail, 'QualityMonitor', 'my_agent', ['my_evaluator']);

    expect(result.name).toBe('QualityMonitor');
    expect(result.agent).toBe('my_agent');
    expect(result.evaluators).toEqual(['my_evaluator']);
    expect(result.samplingRate).toBe(50);
    expect(result.description).toBe('Monitor agent quality');
    expect(result.enableOnCreate).toBe(true);
  });

  it('omits enableOnCreate when execution status is DISABLED', () => {
    const detail: GetOnlineEvalConfigResult = {
      configId: 'oec-456',
      configArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/oec-456',
      configName: 'DisabledConfig',
      status: 'ACTIVE',
      executionStatus: 'DISABLED',
      samplingPercentage: 10,
      serviceNames: ['agent.DEFAULT'],
      evaluatorIds: ['eval-1'],
    };

    const result = toOnlineEvalConfigSpec(detail, 'DisabledConfig', 'agent', ['eval_one']);

    expect(result.enableOnCreate).toBeUndefined();
  });

  it('omits description when not present', () => {
    const detail: GetOnlineEvalConfigResult = {
      configId: 'oec-789',
      configArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/oec-789',
      configName: 'NoDesc',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      samplingPercentage: 25,
      serviceNames: ['agent.DEFAULT'],
      evaluatorIds: ['eval-1'],
    };

    const result = toOnlineEvalConfigSpec(detail, 'NoDesc', 'agent', ['eval_one']);

    expect(result.description).toBeUndefined();
  });

  it('throws when sampling percentage is missing', () => {
    const detail: GetOnlineEvalConfigResult = {
      configId: 'oec-no-sampling',
      configArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/oec-no-sampling',
      configName: 'NoSampling',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      serviceNames: ['agent.DEFAULT'],
      evaluatorIds: ['eval-1'],
    };

    expect(() => toOnlineEvalConfigSpec(detail, 'NoSampling', 'agent', ['eval_one'])).toThrow(
      'has no sampling configuration'
    );
  });

  it('supports multiple evaluator references', () => {
    const detail: GetOnlineEvalConfigResult = {
      configId: 'oec-multi',
      configArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/oec-multi',
      configName: 'MultiEval',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
      samplingPercentage: 75,
      serviceNames: ['agent.DEFAULT'],
      evaluatorIds: ['eval-1', 'eval-2'],
    };

    const result = toOnlineEvalConfigSpec(detail, 'MultiEval', 'agent', [
      'local_eval',
      'arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/eval-2',
    ]);

    expect(result.evaluators).toHaveLength(2);
    expect(result.evaluators[0]).toBe('local_eval');
    expect(result.evaluators[1]).toMatch(/^arn:/);
  });
});

// ============================================================================
// Template Logical ID Lookup Tests for Online Eval Configs
// ============================================================================

describe('Template Logical ID Lookup for Online Eval Configs', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      MyOnlineEvalConfig: {
        Type: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
        Properties: {
          OnlineEvaluationConfigName: 'QualityMonitor',
        },
      },
      PrefixedOnlineEvalConfig: {
        Type: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
        Properties: {
          OnlineEvaluationConfigName: 'TestProject_PrefixedConfig',
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

  it('finds online eval config logical ID by OnlineEvaluationConfigName property', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      'QualityMonitor'
    );
    expect(logicalId).toBe('MyOnlineEvalConfig');
  });

  it('finds prefixed online eval config by full name', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      'TestProject_PrefixedConfig'
    );
    expect(logicalId).toBe('PrefixedOnlineEvalConfig');
  });

  it('finds all online eval config logical IDs by type', () => {
    const logicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::OnlineEvaluationConfig');
    expect(logicalIds).toHaveLength(2);
    expect(logicalIds).toContain('MyOnlineEvalConfig');
    expect(logicalIds).toContain('PrefixedOnlineEvalConfig');
  });

  it('returns undefined for non-existent config name', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      'nonexistent_config'
    );
    expect(logicalId).toBeUndefined();
  });

  it('falls back to single online eval config logical ID when name does not match', () => {
    const singleConfigTemplate: CfnTemplate = {
      Resources: {
        OnlyConfig: {
          Type: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
          Properties: {
            OnlineEvaluationConfigName: 'some_config',
          },
        },
      },
    };

    let logicalId = findLogicalIdByProperty(
      singleConfigTemplate,
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      'different_name'
    );

    // Primary lookup fails
    expect(logicalId).toBeUndefined();

    // Fallback: if there's only one config resource, use it
    if (!logicalId) {
      const configLogicalIds = findLogicalIdsByType(
        singleConfigTemplate,
        'AWS::BedrockAgentCore::OnlineEvaluationConfig'
      );
      if (configLogicalIds.length === 1) {
        logicalId = configLogicalIds[0];
      }
    }
    expect(logicalId).toBe('OnlyConfig');
  });
});

// ============================================================================
// Phase 2 Resource Import List Construction for Online Eval Configs
// ============================================================================

describe('Phase 2: ResourceToImport List Construction for Online Eval Configs', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      OnlineEvalLogicalId: {
        Type: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
        Properties: {
          OnlineEvaluationConfigName: 'QualityMonitor',
        },
      },
      IAMRoleLogicalId: {
        Type: 'AWS::IAM::Role',
        Properties: {},
      },
    },
  };

  it('builds ResourceToImport list for online eval config', () => {
    const configName = 'QualityMonitor';
    const configId = 'oec-123';

    const resourcesToImport: ResourceToImport[] = [];

    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      configName
    );

    if (logicalId) {
      resourcesToImport.push({
        resourceType: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
        logicalResourceId: logicalId,
        resourceIdentifier: { OnlineEvaluationConfigId: configId },
      });
    }

    expect(resourcesToImport).toHaveLength(1);
    expect(resourcesToImport[0]!.resourceType).toBe('AWS::BedrockAgentCore::OnlineEvaluationConfig');
    expect(resourcesToImport[0]!.logicalResourceId).toBe('OnlineEvalLogicalId');
    expect(resourcesToImport[0]!.resourceIdentifier).toEqual({ OnlineEvaluationConfigId: 'oec-123' });
  });

  it('returns empty list when online eval config not found in template', () => {
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
      'AWS::BedrockAgentCore::OnlineEvaluationConfig',
      'OnlineEvaluationConfigName',
      'QualityMonitor'
    );

    expect(logicalId).toBeUndefined();
  });
});

// ============================================================================
// buildImportTemplate Tests for Online Eval Config Resources
// ============================================================================

describe('buildImportTemplate with Online Eval Config', () => {
  it('adds online eval config resource to deployed template with Retain deletion policy', () => {
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
        OnlineEvalLogicalId: {
          Type: 'AWS::BedrockAgentCore::OnlineEvaluationConfig',
          Properties: {
            OnlineEvaluationConfigName: 'QualityMonitor',
          },
          DependsOn: 'ExistingIAMRole',
        },
      },
    };

    const importTemplate = buildImportTemplate(deployedTemplate, synthTemplate, ['OnlineEvalLogicalId']);

    // Verify online eval config resource was added
    expect(importTemplate.Resources.OnlineEvalLogicalId).toBeDefined();
    expect(importTemplate.Resources.OnlineEvalLogicalId!.Type).toBe('AWS::BedrockAgentCore::OnlineEvaluationConfig');
    expect(importTemplate.Resources.OnlineEvalLogicalId!.DeletionPolicy).toBe('Retain');
    expect(importTemplate.Resources.OnlineEvalLogicalId!.UpdateReplacePolicy).toBe('Retain');

    // DependsOn should be removed for import
    expect(importTemplate.Resources.OnlineEvalLogicalId!.DependsOn).toBeUndefined();

    // Original resource should still be there
    expect(importTemplate.Resources.ExistingIAMRole).toBeDefined();
  });
});
