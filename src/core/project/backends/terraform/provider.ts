import type { Memory } from "../../../../projectSchemas/memory";

/** Provider-specific shapes stay here; the backend owns orchestration and state. */
export class TerraformProvider {
  readonly identity = "aws-native-v1";
  readonly requiredProviders = { aws: { source: "hashicorp/aws", version: "6.65.0" } };
  readonly memoryType = "aws_bedrockagentcore_memory";
  readonly runtimeType = "aws_bedrockagentcore_agent_runtime";
  readonly memoryId = "id";
  readonly memoryArn = "arn";
  readonly minimumRetention = 7;

  providers(region: string, account: string): Record<string, unknown> {
    return { aws: { region, allowed_account_ids: [account] } };
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
      protocol_configuration: { server_protocol: protocol },
      ...(lifecycle && {
        lifecycle_configuration: [
          {
            idle_runtime_session_timeout: lifecycle.idleRuntimeSessionTimeout ?? 900,
            max_lifetime: lifecycle.maxLifetime ?? 28800,
          },
        ],
      }),
    };
  }
}
