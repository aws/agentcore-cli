import type {
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export interface CoreRuntimeClient {
  getRuntime(id: string, options: CoreOptions): Promise<GetAgentRuntimeResponse>;
  getRuntimeVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeResponse>;
  getRuntimeEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeEndpointResponse>;
  listRuntimes(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimesResponse>;
  listRuntimeVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeVersionsResponse>;
  listRuntimeEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeEndpointsResponse>;
}
