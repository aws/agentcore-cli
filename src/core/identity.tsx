import {
  CreateApiKeyCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
  UpdateApiKeyCredentialProviderCommand,
  type CreateApiKeyCredentialProviderResponse,
  type DeleteApiKeyCredentialProviderResponse,
  type GetApiKeyCredentialProviderResponse,
  type ListApiKeyCredentialProvidersResponse,
  type UpdateApiKeyCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  CoreIdentityClient,
  CreateApiKeyCredentialProviderInput,
  UpdateApiKeyCredentialProviderInput,
} from "../handlers/identity/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export class IdentityClient implements CoreIdentityClient {
  constructor(private readonly clients: AwsClients) {}

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
}
