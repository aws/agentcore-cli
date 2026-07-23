import type {
  CreateApiKeyCredentialProviderResponse,
  DeleteApiKeyCredentialProviderResponse,
  GetApiKeyCredentialProviderResponse,
  ListApiKeyCredentialProvidersResponse,
  SecretSourceType,
  UpdateApiKeyCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

export interface CreateApiKeyCredentialProviderInput {
  name: string;
  apiKey?: string;
  apiKeySecretConfig?: { secretId: string; jsonKey: string };
  apiKeySecretSource?: SecretSourceType;
  tags?: Record<string, string>;
}

export interface UpdateApiKeyCredentialProviderInput {
  name: string;
  apiKey?: string;
  apiKeySecretConfig?: { secretId: string; jsonKey: string };
  apiKeySecretSource?: SecretSourceType;
}

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
