import {
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
  type CreateAgentRuntimeResponse,
  type UpdateAgentRuntimeResponse,
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
  CreateRuntimeInput,
  DeleteRuntimeInput,
  DeleteRuntimeResult,
  UpdateRuntimeInput,
  RuntimeInvokeRequest,
  RuntimeInvokeResponse,
  RuntimeShellRequest,
  RuntimeShellSession,
} from "../handlers/runtime/types";
import type { Logger } from "../logging";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import { invokeRuntime } from "./invokeRuntime";
import { toClientConfig } from "./utils";
import {
  InvokeAgentRuntimeCommandCommand,
  type InvokeAgentRuntimeCommandRequest,
  type InvokeAgentRuntimeCommandResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import { abortable } from "./abortable";
import { parseArn, serviceIdFromArn } from "./arn";
import { retryWhileRoleUnassumable } from "./harness";
import {
  deleteRuntimeExecutionRole,
  ensureRuntimeExecutionRole,
  refreshRuntimeExecutionRolePolicy,
} from "./runtimeExecutionRole";
import { ResourceNotFoundError } from "../errors";

// Runtime IDs are <name>-<10 characters>; names cannot contain a hyphen.
const RUNTIME_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10}$/;

export type OpenRuntimeShell = (
  request: RuntimeShellRequest,
  options: CoreOptions,
) => Promise<RuntimeShellSession>;

export class RuntimeClient implements CoreRuntimeClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly fetch: CoreFetch,
    private readonly logger: Logger,
    private readonly openShell: OpenRuntimeShell = async () => {
      throw new Error("Runtime shell transport is not configured");
    },
  ) {}

  async invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new InvokeAgentRuntimeCommandCommand(request), { abortSignal });
    if (!response.stream || !abortSignal) return response;
    return { ...response, stream: abortable(response.stream, abortSignal) };
  }

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

  openRuntimeShell(
    request: RuntimeShellRequest,
    options: CoreOptions,
  ): Promise<RuntimeShellSession> {
    return this.openShell(request, options);
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

  async createRuntime(
    input: CreateRuntimeInput,
    options: CoreOptions,
  ): Promise<CreateAgentRuntimeResponse> {
    const control = this.clients.control(toClientConfig(options));
    const request = {
      agentRuntimeName: input.runtimeName,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: input.containerUri } },
      networkConfiguration: input.networkConfiguration ?? { networkMode: "PUBLIC" as const },
      description: input.description,
      protocolConfiguration: input.protocol ? { serverProtocol: input.protocol } : undefined,
      environmentVariables: input.environmentVariables,
      authorizerConfiguration: input.authorizerConfiguration,
      lifecycleConfiguration: input.lifecycleConfiguration,
      tags: input.tags,
    };
    if (input.executionRoleArn) {
      return control.send(
        new CreateAgentRuntimeCommand({ ...request, roleArn: input.executionRoleArn }),
      );
    }
    // IAM is global; the agentcore endpoint override must not leak onto it.
    const roleArn = await ensureRuntimeExecutionRole(
      this.clients.iam({ region: options.region }),
      input.runtimeName,
      options.region,
      input.containerUri,
    );
    return retryWhileRoleUnassumable(() =>
      control.send(new CreateAgentRuntimeCommand({ ...request, roleArn })),
    );
  }

  async updateRuntime(
    input: UpdateRuntimeInput,
    options: CoreOptions,
  ): Promise<UpdateAgentRuntimeResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetAgentRuntimeCommand({ agentRuntimeId: input.runtimeId }),
    );
    const containerUri =
      input.containerUri ?? current.agentRuntimeArtifact?.containerConfiguration?.containerUri;
    if (!containerUri) {
      throw new ResourceNotFoundError(
        `Runtime ${input.runtimeId} is not a container image Runtime; ` +
          "update it the way it was created (for a project Runtime, agentcore deploy).",
      );
    }
    const roleArn = input.executionRoleArn ?? current.roleArn!;
    // A default role grants pull on one repository; follow a new image there.
    if (input.containerUri && !input.executionRoleArn) {
      await refreshRuntimeExecutionRolePolicy(
        this.clients.iam({ region: options.region }),
        current.agentRuntimeName!,
        roleArn,
        options.region,
        containerUri,
      );
    }
    const authorizerConfiguration =
      input.authorizerConfiguration === null
        ? undefined
        : (input.authorizerConfiguration ?? current.authorizerConfiguration);
    return control.send(
      new UpdateAgentRuntimeCommand({
        agentRuntimeId: input.runtimeId,
        agentRuntimeArtifact: { containerConfiguration: { containerUri } },
        roleArn,
        networkConfiguration: input.networkConfiguration ?? current.networkConfiguration,
        description: input.description ?? current.description,
        protocolConfiguration: input.protocol
          ? { serverProtocol: input.protocol }
          : current.protocolConfiguration,
        environmentVariables: input.environmentVariables ?? current.environmentVariables,
        authorizerConfiguration,
        lifecycleConfiguration: input.lifecycleConfiguration ?? current.lifecycleConfiguration,
        requestHeaderConfiguration: current.requestHeaderConfiguration,
        metadataConfiguration: current.metadataConfiguration,
        filesystemConfigurations: current.filesystemConfigurations,
        capacityProviderConfiguration: current.capacityProviderConfiguration,
      }),
    );
  }

  async deleteRuntime(
    input: DeleteRuntimeInput,
    options: CoreOptions,
  ): Promise<DeleteRuntimeResult> {
    const control = this.clients.control(toClientConfig(options));
    // Read first: the role ARN and name are gone once the Runtime is deleted.
    const current = input.deleteExecutionRole
      ? await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: input.runtimeId }))
      : undefined;
    const response = await control.send(
      new DeleteAgentRuntimeCommand({ agentRuntimeId: input.runtimeId }),
    );
    if (!current?.roleArn) return response;
    const deleted = await deleteRuntimeExecutionRole(
      this.clients.iam({ region: options.region }),
      current.agentRuntimeName!,
      current.roleArn,
    );
    return { ...response, executionRole: { roleArn: current.roleArn, deleted } };
  }

  async resolveRuntimeId(identifier: string, options: CoreOptions): Promise<string> {
    if (parseArn(identifier)) return serviceIdFromArn(identifier);
    if (RUNTIME_ID_PATTERN.test(identifier)) return identifier;
    let nextToken: string | undefined;
    do {
      const page = await this.listRuntimes(nextToken, 100, options);
      const match = page.agentRuntimes?.find((runtime) => runtime.agentRuntimeName === identifier);
      if (match?.agentRuntimeId) return match.agentRuntimeId;
      nextToken = page.nextToken;
    } while (nextToken);
    throw new ResourceNotFoundError(
      `No AgentCore Runtime named '${identifier}' in ${options.region}`,
    );
  }
}
