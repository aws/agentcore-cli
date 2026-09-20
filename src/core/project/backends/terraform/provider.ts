import type { Memory } from "../../../../projectSchemas/memory";

/** Typed AWSCC resources call Cloud Control; no CloudFormation stack is created. */
export class TerraformProvider {
  readonly identity = "awscc-v1";
  readonly requiredProviders = {
    aws: { source: "hashicorp/aws", version: "6.65.0" },
    awscc: { source: "hashicorp/awscc", version: "1.102.0" },
  };
  readonly memoryType = "awscc_bedrockagentcore_memory";
  readonly runtimeType = "awscc_bedrockagentcore_runtime";
  readonly memoryId = "memory_id";
  readonly memoryArn = "memory_arn";
  readonly minimumRetention = 3;

  providers(region: string, account: string): Record<string, unknown> {
    return { aws: { region, allowed_account_ids: [account] }, awscc: { region } };
  }

  memory(memory: Memory, name: string, tags: Record<string, string>): Record<string, unknown> {
    return {
      name,
      description: memory.description,
      event_expiry_duration: memory.eventExpiryDuration,
      encryption_key_arn: memory.encryptionKeyArn,
      memory_execution_role_arn: memory.executionRoleArn,
      tags,
    };
  }

  runtime(
    protocol: string,
    lifecycle?: {
      idleRuntimeSessionTimeout?: number;
      maxLifetime?: number;
    },
  ): Record<string, unknown> {
    return {
      protocol_configuration: protocol,
      ...(lifecycle && {
        lifecycle_configuration: {
          idle_runtime_session_timeout: lifecycle.idleRuntimeSessionTimeout ?? 900,
          max_lifetime: lifecycle.maxLifetime ?? 28800,
        },
      }),
    };
  }
}
