import type { CoreOptions } from "../../../../core/types";

export type GeneratePolicyInput = {
  projectName: string;
  engineName: string;
  gatewayName?: string;
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
