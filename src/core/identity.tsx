import {
  CreateApiKeyCredentialProviderCommand,
  CreateOauth2CredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
  UpdateApiKeyCredentialProviderCommand,
  UpdateOauth2CredentialProviderCommand,
  type CreateApiKeyCredentialProviderResponse,
  type CreateOauth2CredentialProviderResponse,
  type DeleteApiKeyCredentialProviderResponse,
  type DeleteOauth2CredentialProviderResponse,
  type GetApiKeyCredentialProviderResponse,
  type GetOauth2CredentialProviderResponse,
  type ListApiKeyCredentialProvidersResponse,
  type ListOauth2CredentialProvidersResponse,
  type UpdateApiKeyCredentialProviderResponse,
  type UpdateOauth2CredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  CoreIdentityClient,
  CreateApiKeyCredentialProviderInput,
  CreateOauth2CredentialProviderInput,
  UpdateApiKeyCredentialProviderInput,
  UpdateOauth2CredentialProviderInput,
} from "../handlers/identity/types";
import { createControlClient } from "./factories";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

// createIdentityClient builds an IdentityClient that owns its control-plane client,
// for callers constructed outside CoreClient (which hands out its cached ones).
export const createIdentityClient = (): IdentityClient =>
  new IdentityClient({ control: createControlClient });

export class IdentityClient implements CoreIdentityClient {
  // Only the control plane is used, so the dependency is narrowed to it: CoreClient
  // still satisfies this by passing itself.
  constructor(private readonly clients: Pick<AwsClients, "control">) {}

  async createApiKeyCredentialProvider(
    input: CreateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateApiKeyCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateApiKeyCredentialProviderCommand(input));
  }

  async getApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetApiKeyCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetApiKeyCredentialProviderCommand({ name }));
  }

  async listApiKeyCredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListApiKeyCredentialProvidersResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListApiKeyCredentialProvidersCommand({ nextToken, maxResults }));
  }

  async updateApiKeyCredentialProvider(
    input: UpdateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateApiKeyCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdateApiKeyCredentialProviderCommand(input));
  }

  async deleteApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteApiKeyCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteApiKeyCredentialProviderCommand({ name }));
  }

  async createOauth2CredentialProvider(
    input: CreateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateOauth2CredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateOauth2CredentialProviderCommand(input));
  }

  async getOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetOauth2CredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetOauth2CredentialProviderCommand({ name }));
  }

  async listOauth2CredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOauth2CredentialProvidersResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListOauth2CredentialProvidersCommand({ nextToken, maxResults }));
  }

  async updateOauth2CredentialProvider(
    input: UpdateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateOauth2CredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdateOauth2CredentialProviderCommand(input));
  }

  async deleteOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteOauth2CredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteOauth2CredentialProviderCommand({ name }));
  }
}
