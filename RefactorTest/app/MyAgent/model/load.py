import os

from strands.models.anthropic import AnthropicModel
from bedrock_agentcore.identity.auth import requires_api_key

IDENTITY_PROVIDER_NAME = ""
IDENTITY_ENV_VAR = ""


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


def load_model() -> AnthropicModel:
    """Get authenticated Anthropic model client."""
    return AnthropicModel(
        client_args={"api_key": _get_api_key()},
        model_id="claude-sonnet-4-5-20250929",
        max_tokens=5000,
    )
