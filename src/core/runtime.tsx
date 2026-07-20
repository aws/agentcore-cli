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
import type { CoreRuntimeClient } from "../handlers/runtime/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export class RuntimeClient implements CoreRuntimeClient {
  constructor(private readonly clients: AwsClients) {}

  async getRuntime(id: string, options: CoreOptions): Promise<GetAgentRuntimeResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetAgentRuntimeCommand({ agentRuntimeId: id }));
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
