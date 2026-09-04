import {
  CreateHarnessCommand,
  CreateHarnessEndpointCommand,
  DeleteHarnessCommand,
  DeleteHarnessEndpointCommand,
  GetHarnessCommand,
  GetHarnessEndpointCommand,
  ListHarnessesCommand,
  ListHarnessEndpointsCommand,
  ListHarnessVersionsCommand,
  UpdateHarnessCommand,
  UpdateHarnessEndpointCommand,
  type CreateHarnessEndpointRequest,
  type CreateHarnessEndpointResponse,
  type CreateHarnessResponse,
  type DeleteHarnessEndpointRequest,
  type DeleteHarnessEndpointResponse,
  type DeleteHarnessRequest,
  type DeleteHarnessResponse,
  type GetHarnessResponse,
  type GetHarnessEndpointResponse,
  type ListHarnessesResponse,
  type ListHarnessEndpointsResponse,
  type ListHarnessVersionsResponse,
  type UpdateHarnessEndpointRequest,
  type UpdateHarnessEndpointResponse,
  type UpdateHarnessRequest,
  type UpdateHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  InvokeAgentRuntimeCommandCommand,
  InvokeHarnessCommand,
  type InvokeAgentRuntimeCommandRequest,
  type InvokeAgentRuntimeCommandResponse,
  type InvokeHarnessRequest,
  type InvokeHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CoreHarnessClient, CreateHarnessInput } from "../handlers/harness/types";
import type { AwsClients, CoreOptions } from "./types";
import { abortable } from "./abortable";
import { ensureDefaultExecutionRole } from "./executionRole";
import { toClientConfig } from "./utils";

// HarnessClient implements the harness-facing operations on top of the shared AWS
// clients provided by CoreClient. It owns no clients of its own; it borrows the
// cached ones so every Core sub-client shares the same connections.
export class HarnessClient implements CoreHarnessClient {
  constructor(private readonly clients: AwsClients) {}

  async getHarness(id: string, options: CoreOptions): Promise<GetHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessCommand({ harnessId: id }));
  }

  async getHarnessVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessCommand({ harnessId: id, harnessVersion: version }));
  }

  async getHarnessEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessEndpointCommand({ harnessId: id, endpointName: qualifier }));
  }

  async listHarnesses(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessesResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessesCommand({ nextToken, maxResults }));
  }

  async listHarnessEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessEndpointsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessEndpointsCommand({ harnessId: id, nextToken, maxResults }));
  }

  async listHarnessVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessVersionsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessVersionsCommand({ harnessId: id, nextToken, maxResults }));
  }

  async createHarness(
    input: CreateHarnessInput,
    options: CoreOptions,
  ): Promise<CreateHarnessResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { executionRoleArn, ...request } = input;
    if (executionRoleArn) {
      return control.send(new CreateHarnessCommand({ ...request, executionRoleArn }));
    }

    // No role supplied: provision (or reuse) the default execution role, then
    // create the harness with it. IAM is eventually consistent — a role created
    // moments ago may not yet be assumable by the AgentCore service principal —
    // so retry the create while the service reports the role as unusable.
    const defaultRoleArn = await ensureDefaultExecutionRole(
      // IAM is a global service; the region only selects the endpoint, and the
      // agentcore endpoint override must not leak onto it.
      this.clients.iam({ region: options.region }),
      input.harnessName!,
      options.region,
    );
    return retryWhileRoleUnassumable(() =>
      control.send(new CreateHarnessCommand({ ...request, executionRoleArn: defaultRoleArn })),
    );
  }

  async updateHarness(
    request: UpdateHarnessRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdateHarnessCommand({ ...request }));
  }

  async deleteHarness(
    request: DeleteHarnessRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteHarnessCommand({ ...request }));
  }

  async createHarnessEndpoint(
    request: CreateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<CreateHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateHarnessEndpointCommand({ ...request }));
  }

  async updateHarnessEndpoint(
    request: UpdateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdateHarnessEndpointCommand({ ...request }));
  }

  async deleteHarnessEndpoint(
    request: DeleteHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteHarnessEndpointCommand({ ...request }));
  }

  async invokeHarness(
    request: InvokeHarnessRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeHarnessResponse> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new InvokeHarnessCommand(request), { abortSignal });
    if (!response.stream || !abortSignal) return response;
    // The SDK honors the abort signal while the request is being established,
    // but once the event stream is flowing, aborting no longer tears the
    // iteration down — consumers awaiting the next event would hang until the
    // turn ran to completion. Racing each read against the signal keeps abort
    // (esc in the TUI) responsive mid-stream.
    return { ...response, stream: abortable(response.stream, abortSignal) };
  }

  async invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new InvokeAgentRuntimeCommandCommand(request), { abortSignal });
    if (!response.stream || !abortSignal) return response;
    // Same mid-stream abort gap as invokeHarness; see above.
    return { ...response, stream: abortable(response.stream, abortSignal) };
  }
}

// retryWhileRoleUnassumable retries `operation` while it fails with the
// validation error AgentCore raises for an execution role it cannot yet assume
// (fresh IAM roles propagate over several seconds). Any other failure — or
// exhausting the attempts — rethrows. Exported for the imperative deploy, which
// supplies the role ARN itself and so bypasses createHarness's own retry.
export async function retryWhileRoleUnassumable<T>(
  operation: () => Promise<T>,
  attempts = 8,
  delayMs = 2000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        (error as Error).name === "ValidationException" &&
        /role|assume|trust/i.test((error as Error).message ?? "");
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
