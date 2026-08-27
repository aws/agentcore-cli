import { setTimeout as sleep } from "node:timers/promises";
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

export class PolicyClient implements CorePolicyClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly logger: Logger,
    private readonly pollDelayMs = GENERATION_POLL_DELAY_MS,
  ) {}

  async *generatePolicy(
    input: GeneratePolicyInput,
    options: CoreOptions,
  ): AsyncGenerator<{ message: string }, GeneratedPolicy> {
    const control = this.clients.control(toClientConfig(options));

    yield { message: `Resolving deployed policy engine '${input.engineName}'` };
    let engine: PolicyEngineSummary | undefined;
    let engineToken: string | undefined;
    do {
      const page = await control.send(
        new ListPolicyEngineSummariesCommand({ nextToken: engineToken }),
      );
      engine = page.policyEngines?.find((candidate) => candidate.name === input.engineServiceName);
      engineToken = page.nextToken;
    } while (!engine && engineToken);
    if (!engine?.policyEngineId) {
      throw new ResourceNotFoundError(
        `policy engine '${input.engineName}' is not deployed; run 'agentcore project deploy' first`,
      );
    }

    yield { message: `Resolving deployed gateway '${input.gatewayName}'` };
    let deployed: GatewaySummary | undefined;
    let gatewayToken: string | undefined;
    do {
      const page = await control.send(new ListGatewaysCommand({ nextToken: gatewayToken }));
      deployed = page.items?.find((candidate) => candidate.name === input.gatewayServiceName);
      gatewayToken = page.nextToken;
    } while (!deployed && gatewayToken);
    if (!deployed) {
      throw new ResourceNotFoundError(
        `gateway '${input.gatewayName}' is not deployed; run 'agentcore project deploy' first`,
      );
    }
    const gateway = await control.send(
      new GetGatewayCommand({ gatewayIdentifier: deployed.gatewayId }),
    );
    if (!gateway.gatewayArn) {
      throw new AgentCoreCLIError(`could not resolve the ARN of gateway '${input.gatewayName}'`);
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
      await sleep(this.pollDelayMs);
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
        status === "GENERATING"
          ? "policy generation did not finish within the CLI's wait window; it may still complete, retry the command in a few minutes"
          : `policy generation did not complete: ${statusReasons?.join(", ") ?? status}`,
      );
    }

    const assets = await control.send(
      new ListPolicyGenerationAssetsCommand({
        policyGenerationId: started.policyGenerationId,
        policyEngineId: engine.policyEngineId,
      }),
    );
    const asset = assets.policyGenerationAssets?.[0];
    // The service returns either plain Cedar or its Dogwood superset member.
    const statement = asset?.definition?.cedar?.statement ?? asset?.definition?.policy?.statement;
    if (!asset || !statement) {
      const findings = (asset?.findings ?? [])
        .map((finding) => `[${finding.type}] ${finding.description}`)
        .join("; ");
      throw new AgentCoreCLIError(
        findings
          ? `the description could not be translated into a Cedar policy: ${findings}`
          : "generation completed but returned no generated policy statement",
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
