{{#if (eq modelProvider "Bedrock")}}
from crewai import LLM

# Uses global inference profile for Claude Sonnet 4.5
# https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
MODEL_ID = "bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0"


def load_model() -> LLM:
    """Get Bedrock model client using IAM credentials."""
    return LLM(model=MODEL_ID)
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import os
from crewai import LLM
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


def load_model() -> LLM:
    """Get authenticated Anthropic model client."""
    api_key = _get_api_key()
    # CrewAI requires ANTHROPIC_API_KEY env var (ignores api_key parameter)
    os.environ["ANTHROPIC_API_KEY"] = api_key
    return LLM(
        model="anthropic/claude-sonnet-4-5-20250929",
        api_key=api_key,
        max_tokens=4096
    )
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import os
from crewai import LLM
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


def load_model() -> LLM:
    """Get authenticated OpenAI model client."""
    api_key = _get_api_key()
    # CrewAI requires OPENAI_API_KEY env var (ignores api_key parameter)
    os.environ["OPENAI_API_KEY"] = api_key
    return LLM(
        model="openai/gpt-4o",
        api_key=api_key
    )
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import os
from crewai import LLM
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


def load_model() -> LLM:
    """Get authenticated Gemini model client."""
    api_key = _get_api_key()
    # CrewAI requires GEMINI_API_KEY env var (ignores api_key parameter)
    os.environ["GEMINI_API_KEY"] = api_key
    return LLM(
        model="gemini/gemini-2.0-flash",
        api_key=api_key
    )
{{/if}}
