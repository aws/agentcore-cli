import os
from langchain_google_genai import ChatGoogleGenerativeAI
from bedrock_agentcore.identity.auth import requires_api_key

IDENTITY_PROVIDER_NAME = "ProtocolTestingGemini"
IDENTITY_ENV_VAR = "AGENTCORE_CREDENTIAL_PROTOCOLTESTINGGEMINI"


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


def load_model() -> ChatGoogleGenerativeAI:
    """Get authenticated Gemini model client."""
    return ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        api_key=_get_api_key()
    )
