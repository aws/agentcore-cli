import os
from bedrock_agentcore.identity.auth import requires_api_key

IDENTITY_PROVIDER_NAME = "{{identityProviders.[0].name}}"
IDENTITY_ENV_VAR = "{{identityProviders.[0].envVarName}}"


@requires_api_key(provider_name=IDENTITY_PROVIDER_NAME)
def _agentcore_identity_api_key_provider(api_key: str) -> str:
    """Fetch API key from AgentCore Identity."""
    return api_key


def _get_api_key() -> str:
    """
    Uses AgentCore Identity for API key management in deployed environments.
    For local development, run via 'agentcore dev' which loads agentcore/.env.
    """
    if os.getenv("LOCAL_DEV") == "1":
        api_key = os.getenv(IDENTITY_ENV_VAR)
        if not api_key:
            raise RuntimeError(
                f"{IDENTITY_ENV_VAR} not found. Add {IDENTITY_ENV_VAR}=your-key to .env.local"
            )
        return api_key
    return _agentcore_identity_api_key_provider()


def load_model() -> None:
    """
    Set up Gemini API key authentication.
    Uses AgentCore Identity for API key management in deployed environments,
    and falls back to .env file for local development.
    Sets the GOOGLE_API_KEY environment variable for the Google ADK.
    """
    api_key = _get_api_key()
    # Use Google AI Studios API Key Authentication.
    # https://google.github.io/adk-docs/agents/models/#google-ai-studio
    os.environ["GOOGLE_API_KEY"] = api_key
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "FALSE"
