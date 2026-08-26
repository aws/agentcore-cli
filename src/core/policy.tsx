import {
  GetGatewayCommand,
  GetPolicyGenerationCommand,
  ListGatewaysCommand,
  ListPolicyEngineSummariesCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
  type GatewaySummary,
  type PolicyEngineSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { AgentCoreCLIError, ResourceNotFoundError } from "../errors";
import type {
  CorePolicyClient,
  GeneratedPolicy,
  GeneratePolicyInput,
} from "../handlers/project/add/policy/types";
import type { Logger } from "../logging";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

const GENERATION_POLL_DELAY_MS = 3_000;
const GENERATION_MAX_POLLS = 40;

type PolicyClientConfig = {
  pollDelayMs?: number;
};

export class PolicyClient implements CorePolicyClient {
  private readonly pollDelayMs: number;

  constructor(
    private readonly clients: AwsClients,
    private readonly logger: Logger,
    config: PolicyClientConfig = {},
  ) {
    this.pollDelayMs = config.pollDelayMs ?? GENERATION_POLL_DELAY_MS;
  }

  async *generatePolicy(
    input: GeneratePolicyInput,
    options: CoreOptions,
  ): AsyncGenerator<{ message: string }, GeneratedPolicy> {
    const control = this.clients.control(toClientConfig(options));

    yield { message: `Resolving deployed policy engine '${input.engineName}'` };
    const engineServiceName = `${input.projectName}_${input.engineName}`;
    let engine: PolicyEngineSummary | undefined;
    let engineToken: string | undefined;
    do {
      const page = await control.send(
        new ListPolicyEngineSummariesCommand({ nextToken: engineToken }),
      );
      engine = page.policyEngines?.find((candidate) => candidate.name === engineServiceName);
      engineToken = page.nextToken;
    } while (!engine && engineToken);
    if (!engine?.policyEngineId) {
      throw new ResourceNotFoundError(
        `policy engine '${input.engineName}' is not deployed; run 'agentcore project deploy' first`,
      );
    }

    yield { message: "Resolving deployed gateway" };
    const gatewayServicePrefix = `${input.projectName}-`;
    const deployed: GatewaySummary[] = [];
    let gatewayToken: string | undefined;
    do {
      const page = await control.send(new ListGatewaysCommand({ nextToken: gatewayToken }));
      for (const candidate of page.items ?? []) {
        const matches = input.gatewayName
          ? candidate.name === `${gatewayServicePrefix}${input.gatewayName}`
          : candidate.name?.startsWith(gatewayServicePrefix);
        if (matches) deployed.push(candidate);
      }
      gatewayToken = page.nextToken;
    } while (gatewayToken);
    if (deployed.length === 0) {
      throw new ResourceNotFoundError(
        input.gatewayName
          ? `gateway '${input.gatewayName}' is not deployed; run 'agentcore project deploy' first`
          : `no deployed gateway found for project '${input.projectName}'; deploy one or pass --gateway`,
      );
    }
    if (!input.gatewayName && deployed.length > 1) {
      throw new AgentCoreCLIError(
        `multiple deployed gateways found: ${deployed
          .map((candidate) => candidate.name)
          .join(", ")}; pass --gateway to choose one`,
      );
    }
    const gateway = await control.send(
      new GetGatewayCommand({ gatewayIdentifier: deployed[0]!.gatewayId }),
    );
    if (!gateway.gatewayArn) {
      throw new AgentCoreCLIError(`could not resolve the ARN of gateway '${deployed[0]!.name}'`);
    }

    yield { message: "Generating a Cedar policy from the description (may take a minute)" };
    const started = await control.send(
      new StartPolicyGenerationCommand({
        policyEngineId: engine.policyEngineId,
        resource: { arn: gateway.gatewayArn },
        content: { rawText: input.description },
        name: `cli_generation_${Date.now()}`,
      }),
    );
    if (!started.policyGenerationId) {
      throw new AgentCoreCLIError("StartPolicyGeneration returned no generation id");
    }

    let status: string | undefined = "GENERATING";
    let statusReasons: string[] | undefined;
    for (let poll = 0; poll < GENERATION_MAX_POLLS && status === "GENERATING"; poll++) {
      await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
      const current = await control.send(
        new GetPolicyGenerationCommand({
          policyGenerationId: started.policyGenerationId,
          policyEngineId: engine.policyEngineId,
        }),
      );
      status = current.status;
      statusReasons = current.statusReasons;
      this.logger.debug(`policy generation ${started.policyGenerationId} status: ${status}`);
      if (status === "GENERATING") yield { message: "Still generating" };
    }
    if (status !== "GENERATED") {
      throw new AgentCoreCLIError(
        `policy generation did not complete: ${statusReasons?.join(", ") ?? status}`,
      );
    }

    const assets = await control.send(
      new ListPolicyGenerationAssetsCommand({
        policyGenerationId: started.policyGenerationId,
        policyEngineId: engine.policyEngineId,
      }),
    );
    const asset = assets.policyGenerationAssets?.[0];
    const statement = asset?.definition?.cedar?.statement;
    if (!statement) {
      throw new AgentCoreCLIError(
        "generation completed but returned no generated policy statement",
      );
    }
    return {
      statement,
      findings: (asset.findings ?? []).map((finding) => ({
        type: finding.type ?? "UNKNOWN",
        description: finding.description ?? "",
      })),
    };
  }
}
