import {
  GetGatewayCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
  waitForPolicyGenerationCompleted,
  type GetPolicyGenerationCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { WaiterState } from "@smithy/core/client";
import { AgentCoreCLIError, ERROR_SOURCE, InputValidationError, NetworkingError } from "../errors";
import type {
  CorePolicyClient,
  GeneratedPolicy,
  GeneratePolicyInput,
  PolicyGenerationResult,
} from "../handlers/gateway/policy/types";
import type { Logger } from "../logging";
import type { ProgressEvent } from "../tui/progress";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export type PolicyGenerationWait = {
  maxWaitTime: number;
  minDelay: number;
  maxDelay: number;
};

const DEFAULT_WAIT: PolicyGenerationWait = { maxWaitTime: 60, minDelay: 2, maxDelay: 5 };

function resourceIdFromArn(value: string): string {
  return value.startsWith("arn:") ? value.slice(value.lastIndexOf("/") + 1) : value;
}

export class PolicyClient implements CorePolicyClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly logger: Logger,
    private readonly wait: PolicyGenerationWait = DEFAULT_WAIT,
  ) {}

  async *generatePolicy(
    input: GeneratePolicyInput,
    options: CoreOptions,
  ): AsyncGenerator<ProgressEvent, PolicyGenerationResult> {
    const control = this.clients.control(toClientConfig(options));
    const gatewayId = resourceIdFromArn(input.gatewayId);

    yield { type: "step", message: `Resolving gateway ${gatewayId}` };
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    const gatewayArn = gateway.gatewayArn!;
    const engine = input.policyEngineId ?? gateway.policyEngineConfiguration?.arn;
    if (!engine) {
      throw new InputValidationError(
        `gateway '${gatewayId}' has no Policy Engine attached; pass --policy-engine-id`,
      );
    }
    const policyEngineId = resourceIdFromArn(engine);

    yield { type: "step", message: `Starting policy generation ${input.name}` };
    const started = await control.send(
      new StartPolicyGenerationCommand({
        policyEngineId,
        resource: { arn: gatewayArn },
        content: { rawText: input.prompt },
        name: input.name,
      }),
    );
    const policyGenerationId = started.policyGenerationId!;
    const meta = { policyGenerationId, policyEngineId };

    yield { type: "step", message: "Waiting for generation to complete" };
    const waited = await waitForPolicyGenerationCompleted(
      { client: control, ...this.wait },
      { policyEngineId, policyGenerationId },
    );
    this.logger.debug(`policy generation ${policyGenerationId} waiter state: ${waited.state}`);
    if (waited.state === WaiterState.TIMEOUT) {
      throw new NetworkingError(
        `policy generation '${policyGenerationId}' did not finish within ${this.wait.maxWaitTime}s; ` +
          "it may still complete on the service",
        { meta },
      );
    }
    if (waited.state !== WaiterState.SUCCESS) {
      const reasons = (waited.reason as GetPolicyGenerationCommandOutput | undefined)
        ?.statusReasons;
      throw new AgentCoreCLIError(
        `policy generation '${policyGenerationId}' failed: ${reasons?.join("; ") ?? waited.state}`,
        { source: ERROR_SOURCE.SERVICE, meta },
      );
    }

    yield { type: "step", message: "Reading generated policies" };
    const policies: GeneratedPolicy[] = [];
    let nextToken: string | undefined;
    do {
      const page = await control.send(
        new ListPolicyGenerationAssetsCommand({ policyEngineId, policyGenerationId, nextToken }),
      );
      for (const asset of page.policyGenerationAssets ?? []) {
        policies.push({
          statement: asset.definition?.cedar?.statement ?? asset.definition?.policy?.statement,
          findings: (asset.findings ?? []).map((finding) => ({
            type: finding.type ?? "UNKNOWN",
            description: finding.description ?? "",
          })),
        });
      }
      nextToken = page.nextToken;
    } while (nextToken);

    if (!policies.some((policy) => policy.statement)) {
      const findings = policies
        .flatMap((policy) => policy.findings)
        .map((finding) => `[${finding.type}] ${finding.description}`)
        .join("; ");
      throw new AgentCoreCLIError(
        `the prompt could not be translated into a Cedar policy${findings ? `: ${findings}` : ""}`,
        { source: ERROR_SOURCE.SERVICE, meta },
      );
    }
    return { policyGenerationId, policyEngineId, gatewayArn, policies };
  }
}
