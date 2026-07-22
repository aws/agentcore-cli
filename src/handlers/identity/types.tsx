import type {
  CreateApiKeyCredentialProviderResponse,
  DeleteApiKeyCredentialProviderResponse,
  GetApiKeyCredentialProviderResponse,
  ListApiKeyCredentialProvidersResponse,
  UpdateApiKeyCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export interface CoreIdentityClient {
  createApiKeyCredentialProvider(
    name: string,
    apiKey: string,
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
    name: string,
    apiKey: string,
    options: CoreOptions,
  ): Promise<UpdateApiKeyCredentialProviderResponse>;
  deleteApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteApiKeyCredentialProviderResponse>;
}
