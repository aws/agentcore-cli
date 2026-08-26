import type { CoreOptions } from "../../../../core/types";

export type GeneratePolicyInput = {
  /** Project-spec names, used in progress and error messages. */
  engineName: string;
  gatewayName: string;
  /** Exact deployed service names the control-plane lookups match against. */
  engineServiceName: string;
  gatewayServiceName: string;
  description: string;
};

export type GeneratedPolicy = {
  statement: string;
  findings: { type: string; description: string }[];
};

export interface CorePolicyClient {
  generatePolicy(
    input: GeneratePolicyInput,
    options: CoreOptions,
  ): AsyncGenerator<{ message: string }, GeneratedPolicy>;
}
