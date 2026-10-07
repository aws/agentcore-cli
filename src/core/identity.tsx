import {
  CreateApiKeyCredentialProviderCommand,
  CreateOauth2CredentialProviderCommand,
  CreatePaymentCredentialProviderCommand,
  CreateWorkloadIdentityCommand,
  DeleteApiKeyCredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  DeletePaymentCredentialProviderCommand,
  DeleteWorkloadIdentityCommand,
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  GetPaymentCredentialProviderCommand,
  GetWorkloadIdentityCommand,
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
  ListPaymentCredentialProvidersCommand,
  ResourceNotFoundException,
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
  type ListPaymentCredentialProvidersResponse,
  type UpdatePaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { GetWorkloadAccessTokenCommand } from "@aws-sdk/client-bedrock-agentcore";
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

export function devWorkloadIdentityName(project: string, target: string): string {
  return `agentcore-dev-${project}-${target}`;
}

export class IdentityClient implements CoreIdentityClient {
  /** Narrowed to the two AgentCore clients so any holder of cached clients satisfies it; CoreClient passes itself. **/
  constructor(private readonly clients: Pick<AwsClients, "control" | "data">) {}

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

  async listPaymentCredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentCredentialProvidersResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListPaymentCredentialProvidersCommand({ nextToken, maxResults }));
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

  async ensureWorkloadIdentity(name: string, options: CoreOptions): Promise<{ created: boolean }> {
    const control = this.clients.control(toClientConfig(options));
    try {
      await control.send(new GetWorkloadIdentityCommand({ name }));
      return { created: false };
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
    try {
      await control.send(new CreateWorkloadIdentityCommand({ name }));
      return { created: true };
    } catch (createError) {
      /** A duplicate create returns ValidationException, so a second get decides whether another developer created it. **/
      try {
        await control.send(new GetWorkloadIdentityCommand({ name }));
        return { created: false };
      } catch {
        throw createError;
      }
    }
  }

  async getWorkloadAccessToken(name: string, options: CoreOptions): Promise<string> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new GetWorkloadAccessTokenCommand({ workloadName: name }));
    return response.workloadAccessToken!;
  }

  async deleteWorkloadIdentity(name: string, options: CoreOptions): Promise<void> {
    await this.clients
      .control(toClientConfig(options))
      .send(new DeleteWorkloadIdentityCommand({ name }));
  }
}
