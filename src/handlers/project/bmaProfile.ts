import type { RuntimeTemplateProfile } from "./templateProfile";

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
    additionalPolicies: ["bma-acr-policy.json"],
    tags: { "agentcore:template": "BedrockManagedAgents" },
  },
} as const satisfies RuntimeTemplateProfile;
