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
const MAX_CONNECTOR_TARGET_PAGES = 101;

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
    const pageSize = maxResults ?? DEFAULT_CONNECTOR_PAGE_SIZE;
    const items: TargetSummary[] = [];
    let token = nextToken;
    let filling = true;

    for (let page = 0; page < MAX_CONNECTOR_TARGET_PAGES; page++) {
      const requestToken = token;
      const requestSize = filling ? pageSize - items.length : DEFAULT_CONNECTOR_PAGE_SIZE;
      const response = await this.listGatewayTargets(gatewayId, token, requestSize, options);
      const connectors = (response.items ?? []).filter(
        (target) => target.targetType === TargetType.CONNECTOR,
      );

      if (filling) {
        items.push(...connectors);
        filling = items.length < pageSize;
      } else if (connectors.length > 0) {
        return { ...response, items, nextToken: requestToken };
      }

      if (response.nextToken === undefined) {
        return { ...response, items, nextToken: undefined };
      }
      token = response.nextToken;
    }

    throw new ResultTruncationError(
      `Gateway Connector discovery exceeded ${MAX_CONNECTOR_TARGET_PAGES} Target pages; results are incomplete`,
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
