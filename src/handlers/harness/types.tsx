import type {
  CreateHarnessEndpointRequest,
  CreateHarnessEndpointResponse,
  CreateHarnessRequest,
  CreateHarnessResponse,
  DeleteHarnessEndpointRequest,
  DeleteHarnessEndpointResponse,
  DeleteHarnessRequest,
  DeleteHarnessResponse,
  GetHarnessResponse,
  GetHarnessEndpointResponse,
  ListHarnessesResponse,
  ListHarnessEndpointsResponse,
  ListHarnessVersionsResponse,
  UpdateHarnessEndpointRequest,
  UpdateHarnessEndpointResponse,
  UpdateHarnessRequest,
  UpdateHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandResponse,
  InvokeHarnessRequest,
  InvokeHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CoreOptions } from "../../core/types";

// CreateHarnessInput is CreateHarnessRequest with the execution role made
// optional: when omitted, Core provisions the default execution role in IAM and
// creates the harness with it.
export type CreateHarnessInput = Omit<CreateHarnessRequest, "executionRoleArn"> & {
  executionRoleArn?: string;
};

export type ResolvedHarnessRuntime = {
  runtimeId: string;
  runtimeName: string;
};

export interface CoreHarnessClient {
  createHarness(input: CreateHarnessInput, options: CoreOptions): Promise<CreateHarnessResponse>;
  updateHarness(
    request: UpdateHarnessRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessResponse>;
  deleteHarness(
    request: DeleteHarnessRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessResponse>;
  createHarnessEndpoint(
    request: CreateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<CreateHarnessEndpointResponse>;
  updateHarnessEndpoint(
    request: UpdateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessEndpointResponse>;
  deleteHarnessEndpoint(
    request: DeleteHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessEndpointResponse>;
  getHarness(id: string, options: CoreOptions): Promise<GetHarnessResponse>;
  resolveRuntime(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<ResolvedHarnessRuntime>;
  getHarnessVersion(id: string, version: string, options: CoreOptions): Promise<GetHarnessResponse>;
  getHarnessEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetHarnessEndpointResponse>;
  listHarnesses(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessesResponse>;
  listHarnessEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessEndpointsResponse>;
  listHarnessVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessVersionsResponse>;
  invokeHarness(
    request: InvokeHarnessRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeHarnessResponse>;
  invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse>;
}
