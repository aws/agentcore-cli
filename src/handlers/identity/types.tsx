import type {
  CreateApiKeyCredentialProviderRequest,
  CreateApiKeyCredentialProviderResponse,
  DeleteApiKeyCredentialProviderResponse,
  GetApiKeyCredentialProviderResponse,
  ListApiKeyCredentialProvidersResponse,
  UpdateApiKeyCredentialProviderRequest,
  UpdateApiKeyCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export type CreateApiKeyCredentialProviderInput = CreateApiKeyCredentialProviderRequest;
export type UpdateApiKeyCredentialProviderInput = UpdateApiKeyCredentialProviderRequest;

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
}
