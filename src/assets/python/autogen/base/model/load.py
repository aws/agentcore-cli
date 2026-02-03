{{#if (eq modelProvider "Bedrock")}}
import os
from autogen_ext.models.anthropic import AnthropicBedrockChatCompletionClient
from autogen_core.models import ModelInfo, ModelFamily

# Uses global inference profile for Claude Sonnet 4.5
# https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"


def load_model() -> AnthropicBedrockChatCompletionClient:
    """Get Bedrock model client using IAM credentials."""
    return AnthropicBedrockChatCompletionClient(
        model=MODEL_ID,
        model_info=ModelInfo(
            vision=False,
            function_calling=True,
            json_output=False,
            family=ModelFamily.CLAUDE_4_SONNET,
            structured_output=True
        ),
        bedrock_info={"aws_region": os.environ.get("AWS_REGION", "us-east-1")}
    )
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import os
from autogen_ext.models.anthropic import AnthropicChatCompletionClient
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


def load_model() -> AnthropicChatCompletionClient:
    """Get authenticated Anthropic model client."""
    return AnthropicChatCompletionClient(
        model="claude-sonnet-4-5-20250929",
        api_key=_get_api_key()
    )
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import os
from autogen_ext.models.openai import OpenAIChatCompletionClient
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


def load_model() -> OpenAIChatCompletionClient:
    """Get authenticated OpenAI model client."""
    return OpenAIChatCompletionClient(
        model="gpt-4o",
        api_key=_get_api_key()
    )
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import os
from autogen_ext.models.openai import OpenAIChatCompletionClient
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


def load_model() -> OpenAIChatCompletionClient:
    """Get authenticated Gemini model client via OpenAI-compatible API."""
    return OpenAIChatCompletionClient(
        model="gemini-2.0-flash",
        api_key=_get_api_key(),
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
    )
{{/if}}
