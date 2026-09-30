import type { RuntimeTemplateProfile } from "./templateProfile";

export const BMA_TEMPLATE_NAME = "bedrock-managed-agents";
export const BMA_POLICY_FILE = "bma-acr-policy.json";
export const BMA_TEMPLATE_TAG_KEY = "agentcore:template";
export const BMA_TEMPLATE_TAG_VALUE = "BedrockManagedAgents";

export const BMA_CUSTOM_EXECUTION_ROLE_WARNING =
  `Warning: --role-arn uses an existing execution role, so AgentCore CDK cannot attach ` +
  `${BMA_POLICY_FILE}. Ensure the role grants bedrock-mantle:RegisterEnvironment and ` +
  `bedrock-mantle:ConnectEnvironment before deploying.`;

export const BMA_TEMPLATE_PROFILE = {
  usesModel: false,
  dependencySetup: "deferred",
  runtime: {
    entrypoint: "lifecycle/server.py",
    dockerfile: "Dockerfile",
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 1800,
      maxLifetime: 28800,
    },
    additionalPolicies: [BMA_POLICY_FILE],
    tags: { [BMA_TEMPLATE_TAG_KEY]: BMA_TEMPLATE_TAG_VALUE },
  },
} as const satisfies RuntimeTemplateProfile;
