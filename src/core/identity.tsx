import {
  CreateApiKeyCredentialProviderCommand,
  CreateOauth2CredentialProviderCommand,
  CreatePaymentCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  DeletePaymentCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  GetPaymentCredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
  UpdateApiKeyCredentialProviderCommand,
  UpdateOauth2CredentialProviderCommand,
  UpdatePaymentCredentialProviderCommand,
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
  type CreatePaymentCredentialProviderResponse,
  type DeletePaymentCredentialProviderResponse,
  type GetPaymentCredentialProviderResponse,
  type UpdatePaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  CoreIdentityClient,
  CreateApiKeyCredentialProviderInput,
  CreateOauth2CredentialProviderInput,
  CreatePaymentCredentialProviderInput,
  UpdateApiKeyCredentialProviderInput,
  UpdateOauth2CredentialProviderInput,
  UpdatePaymentCredentialProviderInput,
} from "../handlers/identity/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export class IdentityClient implements CoreIdentityClient {
  // Narrowed to `control` so any holder of a cached control client satisfies it;
  // CoreClient passes itself.
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

  async createPaymentCredentialProvider(
    input: CreatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreatePaymentCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreatePaymentCredentialProviderCommand(input));
  }

  async getPaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetPaymentCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetPaymentCredentialProviderCommand({ name }));
  }

  async updatePaymentCredentialProvider(
    input: UpdatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdatePaymentCredentialProviderCommand(input));
  }

  async deletePaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeletePaymentCredentialProviderResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeletePaymentCredentialProviderCommand({ name }));
  }
}
