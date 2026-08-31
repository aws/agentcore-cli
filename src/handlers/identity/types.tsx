import type {
  CreateApiKeyCredentialProviderRequest,
  CreateApiKeyCredentialProviderResponse,
  CreateOauth2CredentialProviderRequest,
  CreateOauth2CredentialProviderResponse,
  DeleteApiKeyCredentialProviderResponse,
  DeleteOauth2CredentialProviderResponse,
  GetApiKeyCredentialProviderResponse,
  GetOauth2CredentialProviderResponse,
  ListApiKeyCredentialProvidersResponse,
  ListOauth2CredentialProvidersResponse,
  UpdateApiKeyCredentialProviderRequest,
  UpdateApiKeyCredentialProviderResponse,
  UpdateOauth2CredentialProviderRequest,
  UpdateOauth2CredentialProviderResponse,
  CreatePaymentCredentialProviderRequest,
  CreatePaymentCredentialProviderResponse,
  DeletePaymentCredentialProviderResponse,
  GetPaymentCredentialProviderResponse,
  UpdatePaymentCredentialProviderRequest,
  UpdatePaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export type CreateApiKeyCredentialProviderInput = CreateApiKeyCredentialProviderRequest;
export type UpdateApiKeyCredentialProviderInput = UpdateApiKeyCredentialProviderRequest;
export type CreateOauth2CredentialProviderInput = CreateOauth2CredentialProviderRequest;
export type UpdateOauth2CredentialProviderInput = UpdateOauth2CredentialProviderRequest;
export type CreatePaymentCredentialProviderInput = CreatePaymentCredentialProviderRequest;
export type UpdatePaymentCredentialProviderInput = UpdatePaymentCredentialProviderRequest;

export interface CoreIdentityClient {
  createApiKeyCredentialProvider(
    input: CreateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateApiKeyCredentialProviderResponse>;
  getApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetApiKeyCredentialProviderResponse>;
  listApiKeyCredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListApiKeyCredentialProvidersResponse>;
  updateApiKeyCredentialProvider(
    input: UpdateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateApiKeyCredentialProviderResponse>;
  deleteApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteApiKeyCredentialProviderResponse>;

  createOauth2CredentialProvider(
    input: CreateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateOauth2CredentialProviderResponse>;
  getOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetOauth2CredentialProviderResponse>;
  listOauth2CredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOauth2CredentialProvidersResponse>;
  updateOauth2CredentialProvider(
    input: UpdateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateOauth2CredentialProviderResponse>;
  deleteOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteOauth2CredentialProviderResponse>;

  // Payment credential providers hold a payment vendor's own credentials (a Coinbase
  // CDP API key and wallet secret, or Privy app and authorization secrets). They are
  // provisioned by `project deploy` rather than an `agentcore identity` subcommand.
  createPaymentCredentialProvider(
    input: CreatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreatePaymentCredentialProviderResponse>;
  getPaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetPaymentCredentialProviderResponse>;
  updatePaymentCredentialProvider(
    input: UpdatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentCredentialProviderResponse>;
  deletePaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeletePaymentCredentialProviderResponse>;
}
