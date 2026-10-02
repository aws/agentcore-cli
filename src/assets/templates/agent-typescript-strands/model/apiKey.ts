import { withApiKey } from 'bedrock-agentcore/identity';

const IDENTITY_PROVIDER_NAME =
  process.env.{{identityProviders.[0].envVarName}}_NAME ?? {{safeJson identityProviders.[0].name}};
const IDENTITY_ENV_VAR = {{safeJson identityProviders.[0].envVarName}};

// Fetches the API key from AgentCore Identity. The workload access token is
// taken from the current request's context, so this must run inside the
// invocation handler (it does: the model is loaded per session on first use).
const fetchApiKey = withApiKey({ providerName: IDENTITY_PROVIDER_NAME })(
  async (apiKey: string) => apiKey,
);

/**
 * Uses AgentCore Identity for API key management in deployed environments.
 * For local development, run via 'agentcore dev' which loads agentcore/.env.
 */
export async function getApiKey(): Promise<string> {
  if (process.env.LOCAL_DEV === '1') {
    const apiKey = process.env[IDENTITY_ENV_VAR];
    if (!apiKey) {
      throw new Error(`${IDENTITY_ENV_VAR} not found. Add ${IDENTITY_ENV_VAR}=your-key to .env.local`);
    }
    return apiKey;
  }
  return fetchApiKey();
}
