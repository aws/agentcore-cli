import {
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  ListAgentRuntimeEndpointsCommand,
  ListAgentRuntimesCommand,
  ListAgentRuntimeVersionsCommand,
  type GetAgentRuntimeEndpointResponse,
  type GetAgentRuntimeResponse,
  type ListAgentRuntimeEndpointsResponse,
  type ListAgentRuntimesResponse,
  type ListAgentRuntimeVersionsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  CoreRuntimeClient,
  RuntimeInvokeRequest,
  RuntimeInvokeResponse,
} from "../handlers/runtime/types";
import type { Logger } from "../logging";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import { invokeRuntime } from "./invokeRuntime";
import { toClientConfig } from "./utils";

export class RuntimeClient implements CoreRuntimeClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly fetch: CoreFetch,
    private readonly logger: Logger,
  ) {}

  invokeRuntime(
    request: RuntimeInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeInvokeResponse> {
    return invokeRuntime(
      { clients: this.clients, fetch: this.fetch, logger: this.logger },
      request,
      options,
      signal,
    );
  }

  async getRuntime(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetAgentRuntimeResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetAgentRuntimeCommand({ agentRuntimeId: id }), { abortSignal: signal });
  }

  async getRuntimeVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetAgentRuntimeCommand({
        agentRuntimeId: id,
        agentRuntimeVersion: version,
      }),
    );
  }

  async getRuntimeEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeEndpointResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetAgentRuntimeEndpointCommand({
        agentRuntimeId: id,
        endpointName: qualifier,
      }),
    );
  }

  async listRuntimes(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimesResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListAgentRuntimesCommand({ nextToken, maxResults }));
  }

  async listRuntimeVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeVersionsResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListAgentRuntimeVersionsCommand({
        agentRuntimeId: id,
        nextToken,
        maxResults,
      }),
    );
  }

  async listRuntimeEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeEndpointsResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListAgentRuntimeEndpointsCommand({
        agentRuntimeId: id,
        nextToken,
        maxResults,
      }),
    );
  }
}
