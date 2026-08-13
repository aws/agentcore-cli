import type {
  CreateGatewayRequest,
  CreateGatewayResponse,
  CreateGatewayRuleRequest,
  CreateGatewayRuleResponse,
  CreateGatewayTargetRequest,
  CreateGatewayTargetResponse,
  DeleteGatewayResponse,
  DeleteGatewayRuleResponse,
  DeleteGatewayTargetResponse,
  GetGatewayResponse,
  GetGatewayRuleResponse,
  GetGatewayTargetResponse,
  ListGatewayRulesResponse,
  ListGatewaysResponse,
  ListGatewayTargetsResponse,
  UpdateGatewayRequest,
  UpdateGatewayResponse,
  UpdateGatewayRuleRequest,
  UpdateGatewayRuleResponse,
  UpdateGatewayTargetRequest,
  UpdateGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export type GatewayProtocol = "mcp";

export type CreateGatewayInput = Omit<CreateGatewayRequest, "protocolType"> & {
  protocol?: GatewayProtocol;
};

export type CreateGatewayTargetInput = CreateGatewayTargetRequest;

export type CreateGatewayRuleInput = CreateGatewayRuleRequest;

export type GatewayUpdatePatch = {
  id: string;
  roleArn?: UpdateGatewayRequest["roleArn"];
  clearProtocol?: boolean;
  description?: UpdateGatewayRequest["description"] | null;
  protocolConfiguration?: UpdateGatewayRequest["protocolConfiguration"] | null;
  authorizerConfiguration?: UpdateGatewayRequest["authorizerConfiguration"];
  customTransformConfiguration?: UpdateGatewayRequest["customTransformConfiguration"] | null;
  interceptorConfigurations?: UpdateGatewayRequest["interceptorConfigurations"] | null;
  policyEngineConfiguration?: Partial<
    NonNullable<UpdateGatewayRequest["policyEngineConfiguration"]>
  > | null;
  exceptionLevel?: UpdateGatewayRequest["exceptionLevel"] | null;
  wafConfiguration?: UpdateGatewayRequest["wafConfiguration"] | null;
};

export type GatewayTargetUpdatePatch = {
  gatewayId: string;
  targetId: string;
  name?: UpdateGatewayTargetRequest["name"];
  description?: UpdateGatewayTargetRequest["description"] | null;
  endpoint?: string;
  targetConfiguration?: UpdateGatewayTargetRequest["targetConfiguration"];
  credentialProviderConfigurations?:
    UpdateGatewayTargetRequest["credentialProviderConfigurations"] | null;
  metadataConfiguration?: UpdateGatewayTargetRequest["metadataConfiguration"] | null;
  privateEndpoint?: UpdateGatewayTargetRequest["privateEndpoint"] | null;
};

export type GatewayRuleUpdateInput = UpdateGatewayRuleRequest;

export interface CoreGatewayClient {
  createGateway(input: CreateGatewayInput, options: CoreOptions): Promise<CreateGatewayResponse>;
  updateGateway(patch: GatewayUpdatePatch, options: CoreOptions): Promise<UpdateGatewayResponse>;
  getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse>;
  listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse>;
  deleteGateway(id: string, options: CoreOptions): Promise<DeleteGatewayResponse>;
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
  getGatewayConnector(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse>;
  listGatewayConnectors(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse>;
  updateGatewayTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse>;
  updateGatewayConnector(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse>;
  deleteGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayTargetResponse>;
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
  updateGatewayRule(
    input: GatewayRuleUpdateInput,
    options: CoreOptions,
  ): Promise<UpdateGatewayRuleResponse>;
  deleteGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayRuleResponse>;
}
