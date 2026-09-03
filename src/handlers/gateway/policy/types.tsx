import type { CoreOptions } from "../../../core/types";
import type { ProgressEvent } from "../../../tui/progress";

export type GeneratePolicyInput = {
  /** Gateway ID or ARN. */
  gatewayId: string;
  /** Policy Engine ID or ARN. Omitted means the gateway's attached engine. */
  policyEngineId?: string;
  prompt: string;
  name: string;
};

export type GeneratedPolicy = {
  /** Absent when the service could not translate this fragment. */
  statement?: string;
  findings: { type: string; description: string }[];
};

export type PolicyGenerationResult = {
  policyGenerationId: string;
  policyEngineId: string;
  gatewayArn: string;
  policies: GeneratedPolicy[];
};

export interface CorePolicyClient {
  generatePolicy(
    input: GeneratePolicyInput,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<ProgressEvent, PolicyGenerationResult>;
}
