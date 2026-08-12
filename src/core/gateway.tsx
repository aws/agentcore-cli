import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  ListGatewayRulesCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  TargetType,
  type CreateGatewayResponse,
  type CreateGatewayRuleResponse,
  type CreateGatewayTargetResponse,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type ListGatewayRulesResponse,
  type ListGatewaysResponse,
  type ListGatewayTargetsResponse,
  type TargetConfiguration,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, ResultTruncationError } from "../errors";
import type {
  CoreGatewayClient,
  CreateGatewayInput,
  CreateGatewayRuleInput,
  CreateGatewayTargetInput,
} from "../handlers/gateway/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

const DEFAULT_CONNECTOR_PAGE_SIZE = 100;
const CONNECTOR_TARGET_SCAN_PAGE_SIZE = 1000;
const MAX_CONNECTOR_TARGET_SCAN_REQUESTS = 101;

export class GatewayClient implements CoreGatewayClient {
  constructor(private readonly clients: AwsClients) {}

  async createGateway(
    input: CreateGatewayInput,
    options: CoreOptions,
  ): Promise<CreateGatewayResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { protocol, roleArn, ...request } = input;
    return control.send(
      new CreateGatewayCommand({
        ...request,
        roleArn,
        ...(protocol === "mcp" ? { protocolType: "MCP" as const } : {}),
      }),
    );
  }

  async getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetGatewayCommand({ gatewayIdentifier: id }));
  }

  async listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListGatewaysCommand({ nextToken, maxResults }));
  }

  async getGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayTargetCommand({
        gatewayIdentifier: gatewayId,
        targetId,
      }),
    );
  }

  async listGatewayTargets(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayTargetsCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayTarget(
    input: CreateGatewayTargetInput,
    options: CoreOptions,
  ): Promise<CreateGatewayTargetResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateGatewayTargetCommand(input));
  }

  async getGatewayConnector(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    const target = await this.getGatewayTarget(gatewayId, targetId, options);
    if (!GatewayClient.isConnectorTarget(target.targetConfiguration)) {
      throw new InputValidationError(`Gateway Target "${targetId}" is not connector-backed`);
    }
    return target;
  }

  async listGatewayConnectors(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    const connectorPageSize = maxResults ?? DEFAULT_CONNECTOR_PAGE_SIZE;
    const items: TargetSummary[] = [];
    let targetToken = nextToken;

    for (let request = 0; request < MAX_CONNECTOR_TARGET_SCAN_REQUESTS; request++) {
      const requestToken = targetToken;
      const response = await this.listGatewayTargets(
        gatewayId,
        targetToken,
        CONNECTOR_TARGET_SCAN_PAGE_SIZE,
        options,
      );
      const targets = response.items ?? [];
      const connectors = targets.filter((target) => target.targetType === TargetType.CONNECTOR);

      if (items.length < connectorPageSize) {
        const remaining = connectorPageSize - items.length;
        if (connectors.length > remaining) {
          const boundaryTarget = connectors[remaining - 1]!;
          const boundarySize = targets.indexOf(boundaryTarget) + 1;
          // Re-read only through the last returned Connector so the AWS token cannot skip matches.
          const boundaryResponse = await this.listGatewayTargets(
            gatewayId,
            requestToken,
            boundarySize,
            options,
          );

          items.push(...connectors.slice(0, remaining));
          return { ...boundaryResponse, items };
        }
        items.push(...connectors);
      } else if (connectors.length > 0) {
        return { ...response, items, nextToken: requestToken };
      }

      if (response.nextToken === undefined) {
        return { ...response, items, nextToken: undefined };
      }
      targetToken = response.nextToken;
    }

    throw new ResultTruncationError(
      `Gateway Connector discovery exceeded ${MAX_CONNECTOR_TARGET_SCAN_REQUESTS} Target scan requests; results are incomplete`,
    );
  }

  async getGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<GetGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayRuleCommand({
        gatewayIdentifier: gatewayId,
        ruleId,
      }),
    );
  }

  async listGatewayRules(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayRulesResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayRulesCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayRule(
    input: CreateGatewayRuleInput,
    options: CoreOptions,
  ): Promise<CreateGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateGatewayRuleCommand(input));
  }

  private static isConnectorTarget(configuration: TargetConfiguration | undefined): boolean {
    return (
      configuration?.mcp?.connector !== undefined ||
      configuration?.inference?.connector !== undefined
    );
  }
}
