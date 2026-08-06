import type {
  AuthorizerConfiguration,
  CreateGatewayRequest,
  CreateGatewayResponse,
  CreateGatewayRuleRequest,
  CreateGatewayRuleResponse,
  CreateGatewayTargetRequest,
  CreateGatewayTargetResponse,
  CustomTransformConfiguration,
  ExceptionLevel,
  GatewayInterceptorConfiguration,
  GatewayPolicyEngineConfiguration,
  GatewayProtocolConfiguration,
  GetGatewayResponse,
  GetGatewayRuleResponse,
  GetGatewayTargetResponse,
  ListGatewayRulesResponse,
  ListGatewaysResponse,
  ListGatewayTargetsResponse,
  MetadataConfiguration,
  PrivateEndpoint,
  TargetConfiguration,
  UpdateGatewayResponse,
  UpdateGatewayRuleRequest,
  UpdateGatewayRuleResponse,
  UpdateGatewayTargetResponse,
  WafConfiguration,
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
  roleArn?: string;
  clearProtocol?: boolean;
  description?: string | null;
  protocolConfiguration?: GatewayProtocolConfiguration | null;
  authorizerConfiguration?: AuthorizerConfiguration;
  customTransformConfiguration?: CustomTransformConfiguration | null;
  interceptorConfigurations?: GatewayInterceptorConfiguration[] | null;
  policyEngineConfiguration?: Partial<GatewayPolicyEngineConfiguration> | null;
  exceptionLevel?: ExceptionLevel | null;
  wafConfiguration?: WafConfiguration | null;
};

export type GatewayTargetUpdatePatch = {
  gatewayId: string;
  targetId: string;
  name?: string;
  description?: string | null;
  endpoint?: string;
  targetConfiguration?: TargetConfiguration;
  credentialProviderConfigurations?:
    CreateGatewayTargetRequest["credentialProviderConfigurations"] | null;
  metadataConfiguration?: MetadataConfiguration | null;
  privateEndpoint?: PrivateEndpoint | null;
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
}
