import type {
  CreateGatewayRequest,
  CreateGatewayResponse,
  CreateGatewayRuleRequest,
  CreateGatewayRuleResponse,
  CreateGatewayTargetRequest,
  CreateGatewayTargetResponse,
  GetGatewayResponse,
  GetGatewayRuleResponse,
  GetGatewayTargetResponse,
  ListGatewayRulesResponse,
  ListGatewaysResponse,
  ListGatewayTargetsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export type GatewayProtocol = "mcp";

export type CreateGatewayInput = Omit<CreateGatewayRequest, "protocolType"> & {
  protocol?: GatewayProtocol;
};

export type CreateGatewayTargetInput = CreateGatewayTargetRequest;

export type CreateGatewayRuleInput = CreateGatewayRuleRequest;

export interface CoreGatewayClient {
  createGateway(input: CreateGatewayInput, options: CoreOptions): Promise<CreateGatewayResponse>;
  getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse>;
  listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse>;
  getGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse>;
  listGatewayTargets(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse>;
  createGatewayTarget(
    input: CreateGatewayTargetInput,
    options: CoreOptions,
  ): Promise<CreateGatewayTargetResponse>;
  getGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<GetGatewayRuleResponse>;
  listGatewayRules(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayRulesResponse>;
  createGatewayRule(
    input: CreateGatewayRuleInput,
    options: CoreOptions,
  ): Promise<CreateGatewayRuleResponse>;
}
