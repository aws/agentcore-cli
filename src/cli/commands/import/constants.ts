/**
 * CloudFormation resource type to identifier key mapping for IMPORT.
 */
export const CFN_RESOURCE_IDENTIFIERS: Record<string, string[]> = {
  'AWS::BedrockAgentCore::Runtime': ['AgentRuntimeId'],
  'AWS::BedrockAgentCore::Memory': ['MemoryId'],
  'AWS::BedrockAgentCore::Gateway': ['GatewayIdentifier'],
};

/**
 * CloudFormation resource types that are primary (importable) resources.
 * Everything else is a companion resource.
 */
export const PRIMARY_RESOURCE_TYPES = [
  'AWS::BedrockAgentCore::Runtime',
  'AWS::BedrockAgentCore::Memory',
  'AWS::BedrockAgentCore::Gateway',
  'AWS::BedrockAgentCore::GatewayTarget',
  'AWS::BedrockAgentCore::Evaluator',
  'AWS::BedrockAgentCore::OnlineEvaluationConfig',
  'AWS::BedrockAgentCore::RuntimeEndpoint',
  'AWS::BedrockAgentCore::WorkloadIdentity',
  'AWS::BedrockAgentCore::BrowserCustom',
  'AWS::BedrockAgentCore::BrowserProfile',
  'AWS::BedrockAgentCore::CodeInterpreterCustom',
  'AWS::BedrockAgentCore::Policy',
  'AWS::BedrockAgentCore::PolicyEngine',
];

/**
 * Map from starter toolkit runtime_type to CLI runtimeVersion.
 * CLI schema uses PYTHON_3_XX format (matching the Zod enum).
 */
export const RUNTIME_TYPE_MAP: Record<string, string> = {
  PYTHON_3_10: 'PYTHON_3_10',
  PYTHON_3_11: 'PYTHON_3_11',
  PYTHON_3_12: 'PYTHON_3_12',
  PYTHON_3_13: 'PYTHON_3_13',
};
