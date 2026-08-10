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
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export type CreateApiKeyCredentialProviderInput = CreateApiKeyCredentialProviderRequest;
export type UpdateApiKeyCredentialProviderInput = UpdateApiKeyCredentialProviderRequest;
export type CreateOauth2CredentialProviderInput = CreateOauth2CredentialProviderRequest;
export type UpdateOauth2CredentialProviderInput = UpdateOauth2CredentialProviderRequest;

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
}
