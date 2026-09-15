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
import { FilteredPaginator } from "./filteredPaginator";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

// Documented maxResults ceilings of the Identity list APIs. A TUI page can be
// taller than either, so a larger page is assembled from several service calls.
const API_KEY_LIST_MAX_RESULTS = 100;
const OAUTH2_LIST_MAX_RESULTS = 20;

type ProviderPage<TItem> = {
  credentialProviders: TItem[] | undefined;
  nextToken?: string | undefined;
};

type ListProvidersInput = { nextToken?: string | undefined; maxResults?: number | undefined };

export class IdentityClient implements CoreIdentityClient {
  // Narrowed to `control` so any holder of a cached control client satisfies it;
  // CoreClient passes itself.
  constructor(private readonly clients: Pick<AwsClients, "control">) {}

  // Without maxResults the call passes straight through and the service picks
  // the page size. With one, a page larger than the service cap is filled from
  // consecutive service calls; the caps are the only Identity-specific input.
  private static async listProviders<TItem>(
    send: (input: ListProvidersInput) => Promise<ProviderPage<TItem>>,
    nextToken: string | undefined,
    maxResults: number | undefined,
    maxResultsCap: number,
    resourceLabel: string,
  ): Promise<ProviderPage<TItem>> {
    if (maxResults === undefined) return send({ nextToken, maxResults });
    const page = await FilteredPaginator.paginate({
      fetchPage: async (token, size) => {
        const response = await send({ nextToken: token, maxResults: size });
        return { items: response.credentialProviders ?? [], nextToken: response.nextToken };
      },
      nextToken,
      maxResults,
      defaultPageSize: maxResultsCap,
      scanPageSize: maxResultsCap,
      resourceLabel,
    });
    return { credentialProviders: page.items, nextToken: page.nextToken };
  }

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
    const control = this.clients.control(toClientConfig(options));
    return IdentityClient.listProviders(
      (input) => control.send(new ListApiKeyCredentialProvidersCommand(input)),
      nextToken,
      maxResults,
      API_KEY_LIST_MAX_RESULTS,
      "API key credential provider",
    );
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
    const control = this.clients.control(toClientConfig(options));
    return IdentityClient.listProviders(
      (input) => control.send(new ListOauth2CredentialProvidersCommand(input)),
      nextToken,
      maxResults,
      OAUTH2_LIST_MAX_RESULTS,
      "OAuth2 credential provider",
    );
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
