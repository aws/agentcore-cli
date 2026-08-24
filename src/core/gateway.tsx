import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  ListGatewayRulesCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  TargetType,
  UpdateGatewayCommand,
  UpdateGatewayRuleCommand,
  UpdateGatewayTargetCommand,
  type CreateGatewayResponse,
  type CreateGatewayRuleResponse,
  type CreateGatewayTargetResponse,
  type DeleteGatewayResponse,
  type DeleteGatewayRuleResponse,
  type DeleteGatewayTargetResponse,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type ListGatewayRulesResponse,
  type ListGatewaysResponse,
  type ListGatewayTargetsResponse,
  type TargetConfiguration,
  type TargetSummary,
  type UpdateGatewayRequest,
  type UpdateGatewayResponse,
  type UpdateGatewayRuleResponse,
  type UpdateGatewayTargetRequest,
  type UpdateGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  ResultTruncationError,
} from "../errors";
import type {
  CoreGatewayClient,
  CreateGatewayInput,
  CreateGatewayRuleInput,
  CreateGatewayTargetInput,
  GatewayRuleUpdateInput,
  GatewayTargetUpdatePatch,
  GatewayUpdatePatch,
  GatewayInvokeRequest,
  GatewayInvokeResponse,
} from "../handlers/gateway/types";
import type { Logger } from "../logging";
import { abortable } from "./abortable";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

const DEFAULT_CONNECTOR_PAGE_SIZE = 100;
const CONNECTOR_TARGET_SCAN_PAGE_SIZE = 1000;
const MAX_CONNECTOR_TARGET_SCAN_REQUESTS = 101;

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toQuery(url: URL): Record<string, string | string[]> {
  const query = Object.create(null) as Record<string, string | string[]>;
  for (const field of url.search.slice(1).split("&")) {
    if (!field) continue;
    const separator = field.indexOf("=");
    const name = decodeQueryComponent(separator < 0 ? field : field.slice(0, separator));
    const value = decodeQueryComponent(separator < 0 ? "" : field.slice(separator + 1));
    const previous = query[name];
    if (previous === undefined) query[name] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else query[name] = [previous, value];
  }
  return query;
}

export class GatewayClient implements CoreGatewayClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly fetch: CoreFetch,
    private readonly logger: Logger,
  ) {}

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

  async invokeGateway(
    request: GatewayInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GatewayInvokeResponse> {
    const logger = this.logger.child({
      operation: "invokeGateway",
      authMode: request.authorizerType,
      gatewayId: request.gatewayId,
      method: request.method,
      region: options.region,
    });
    const url = new URL(request.url);
    if (url.protocol !== "https:") {
      throw new TypeError("Gateway invocation requires an HTTPS URL");
    }

    const headers = new Headers(request.applicationHeaders);
    try {
      if (request.contentType !== undefined) headers.set("Content-Type", request.contentType);
      if (request.accept !== undefined) headers.set("Accept", request.accept);
      if (request.runtimeSessionId !== undefined) {
        headers.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", request.runtimeSessionId);
      }
      if (request.mcpSessionId !== undefined) {
        headers.set("Mcp-Session-Id", request.mcpSessionId);
      }
      if (request.mcpProtocolVersion !== undefined) {
        headers.set("Mcp-Protocol-Version", request.mcpProtocolVersion);
      }
      if (request.authorizerType === "CUSTOM_JWT") {
        headers.set("Authorization", `Bearer ${request.bearerToken}`);
      }
    } catch {
      throw new TypeError("Invalid Gateway request header");
    }

    let fetchHeaders: RequestInit["headers"] = headers;
    try {
      if (request.authorizerType === "AWS_IAM" || request.authorizerType === "AUTHENTICATE_ONLY") {
        const client = this.clients.data(toClientConfig(options));
        const signer = await client.config.signer({
          name: "sigv4",
          signingName: "bedrock-agentcore",
          signingRegion: options.region,
          properties: {},
        });
        const signed = await signer.sign({
          method: request.method,
          protocol: url.protocol,
          hostname: url.hostname,
          ...(url.port && { port: Number(url.port) }),
          path: url.pathname,
          query: toQuery(url),
          headers: {
            ...Object.fromEntries(headers.entries()),
            host: url.host,
          },
          ...(request.payload !== undefined && { body: request.payload }),
        });
        fetchHeaders = signed.headers;
      }

      const response = await this.fetch(url, {
        method: request.method,
        redirect: "manual",
        headers: fetchHeaders,
        ...(request.payload !== undefined && {
          body: request.payload as RequestInit["body"],
        }),
        signal,
      });
      if (!response.ok) {
        logger
          .child({ httpStatusCode: response.status })
          .debug("Gateway invocation returned a non-success response");
      }

      const body = (response.body as AsyncIterable<Uint8Array> | null) ?? emptyBody();
      return {
        statusCode: response.status,
        contentType: response.headers.get("content-type") ?? "",
        runtimeSessionId:
          response.headers.get("x-amzn-bedrock-agentcore-runtime-session-id") ?? undefined,
        mcpSessionId: response.headers.get("mcp-session-id") ?? undefined,
        mcpProtocolVersion: response.headers.get("mcp-protocol-version") ?? undefined,
        requestId:
          response.headers.get("x-amzn-requestid") ??
          response.headers.get("x-amz-request-id") ??
          undefined,
        body: signal ? abortable(body, signal) : body,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      logger
        .child({
          errorName:
            error instanceof TypeError
              ? "TypeError"
              : error instanceof Error
                ? "Error"
                : typeof error,
        })
        .debug("Gateway invocation transport failed");
      throw new Error("Gateway invocation failed");
    }
  }

  async getGateway(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetGatewayResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetGatewayCommand({ gatewayIdentifier: id }), { abortSignal: signal });
  }

  async updateGateway(
    patch: GatewayUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetGatewayCommand({ gatewayIdentifier: patch.id }));
    const resource = `Gateway "${patch.id}"`;
    const name = GatewayClient.required(current.name, resource, "name");
    const roleArn = GatewayClient.required(current.roleArn, resource, "role ARN");
    const authorizerType = GatewayClient.required(
      current.authorizerType,
      resource,
      "authorizer type",
    );
    if (patch.authorizerConfiguration !== undefined && authorizerType !== "CUSTOM_JWT") {
      throw new InputValidationError(
        "Authorizer configuration can only be updated for a CUSTOM_JWT Gateway",
      );
    }

    let policyEngineConfiguration = current.policyEngineConfiguration;
    if (patch.policyEngineConfiguration === null) {
      policyEngineConfiguration = undefined;
    } else if (patch.policyEngineConfiguration !== undefined) {
      const arn = patch.policyEngineConfiguration.arn ?? current.policyEngineConfiguration?.arn;
      const mode = patch.policyEngineConfiguration.mode ?? current.policyEngineConfiguration?.mode;
      if (!arn || !mode) {
        throw new InputValidationError(
          "Policy Engine update requires an ARN and mode, either existing or supplied",
        );
      }
      policyEngineConfiguration = { arn, mode };
    }

    const description = GatewayClient.replace(current.description, patch.description);
    const protocolConfiguration = GatewayClient.replace(
      current.protocolConfiguration,
      patch.protocolConfiguration,
    );
    const customTransformConfiguration = GatewayClient.replace(
      current.customTransformConfiguration,
      patch.customTransformConfiguration,
    );
    const interceptorConfigurations = GatewayClient.replace(
      current.interceptorConfigurations,
      patch.interceptorConfigurations,
    );
    const exceptionLevel = GatewayClient.replace(current.exceptionLevel, patch.exceptionLevel);
    const wafConfiguration = GatewayClient.replace(
      current.wafConfiguration,
      patch.wafConfiguration,
    );
    const request: UpdateGatewayRequest = {
      gatewayIdentifier: patch.id,
      name,
      roleArn: patch.roleArn ?? roleArn,
      authorizerType,
      description,
      protocolType: patch.clearProtocol ? undefined : current.protocolType,
      protocolConfiguration,
      authorizerConfiguration: patch.authorizerConfiguration ?? current.authorizerConfiguration,
      kmsKeyArn: current.kmsKeyArn,
      customTransformConfiguration,
      interceptorConfigurations,
      policyEngineConfiguration,
      exceptionLevel,
      wafConfiguration,
    };
    return control.send(new UpdateGatewayCommand(request));
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

  async deleteGateway(id: string, options: CoreOptions): Promise<DeleteGatewayResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteGatewayCommand({ gatewayIdentifier: id }));
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

  async updateGatewayTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    return this.updateTarget(patch, options, false);
  }

  async updateGatewayConnector(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    return this.updateTarget(patch, options, true);
  }

  async deleteGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayTargetResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new DeleteGatewayTargetCommand({
        gatewayIdentifier: gatewayId,
        targetId,
      }),
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

  async updateGatewayRule(
    input: GatewayRuleUpdateInput,
    options: CoreOptions,
  ): Promise<UpdateGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(new UpdateGatewayRuleCommand(input));
  }

  async deleteGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new DeleteGatewayRuleCommand({
        gatewayIdentifier: gatewayId,
        ruleId,
      }),
    );
  }

  private async updateTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
    connectorOnly: boolean,
  ): Promise<UpdateGatewayTargetResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetGatewayTargetCommand({
        gatewayIdentifier: patch.gatewayId,
        targetId: patch.targetId,
      }),
    );
    const currentTargetConfiguration = GatewayClient.required(
      current.targetConfiguration,
      `Gateway Target "${patch.targetId}"`,
      "configuration",
    );
    if (connectorOnly && !GatewayClient.isConnectorTarget(currentTargetConfiguration)) {
      throw new InputValidationError(`Gateway Target "${patch.targetId}" is not connector-backed`);
    }

    let targetConfiguration = patch.targetConfiguration;
    if (targetConfiguration === undefined && patch.endpoint !== undefined) {
      const mcpServer = currentTargetConfiguration.mcp?.mcpServer;
      if (!mcpServer) {
        throw new InputValidationError("Endpoint updates require an existing MCP server Target");
      }
      targetConfiguration = {
        mcp: {
          mcpServer: {
            ...mcpServer,
            endpoint: patch.endpoint,
          },
        },
      };
    }
    targetConfiguration ??= currentTargetConfiguration;

    const name = GatewayClient.replace(current.name, patch.name);
    const description = GatewayClient.replace(current.description, patch.description);
    const credentialProviderConfigurations = GatewayClient.replace(
      current.credentialProviderConfigurations,
      patch.credentialProviderConfigurations,
    );
    const metadataConfiguration = GatewayClient.replace(
      current.metadataConfiguration,
      patch.metadataConfiguration,
    );
    const privateEndpoint = GatewayClient.replace(current.privateEndpoint, patch.privateEndpoint);
    const request: UpdateGatewayTargetRequest = {
      gatewayIdentifier: patch.gatewayId,
      targetId: patch.targetId,
      targetConfiguration,
      name,
      description,
      credentialProviderConfigurations,
      metadataConfiguration,
      privateEndpoint,
    };
    if (connectorOnly && !GatewayClient.isConnectorTarget(request.targetConfiguration)) {
      throw new InputValidationError(
        "Connector updates require an MCP or inference connector Target configuration",
      );
    }
    return control.send(new UpdateGatewayTargetCommand(request));
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }

  private static required<T>(value: T | undefined, resource: string, field: string): T {
    if (value === undefined) {
      throw new AgentCoreCLIError(`${resource} is missing its ${field} required for update`, {
        source: ERROR_SOURCE.SERVICE,
      });
    }
    return value;
  }

  private static isConnectorTarget(configuration: TargetConfiguration | undefined): boolean {
    return (
      configuration?.mcp?.connector !== undefined ||
      configuration?.inference?.connector !== undefined
    );
  }
}
