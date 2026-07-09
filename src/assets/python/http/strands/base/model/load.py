{{#if (eq modelProvider "Bedrock")}}
{{#if bedrockMantle}}
import os

from aws_bedrock_token_generator import provide_token
{{#if (eq mantleApiFormat "chat_completions")}}
from strands.models.openai import OpenAIModel
{{else}}
{{#if mantleProprietary}}
from strands.models.openai_responses import OpenAIResponsesModel
{{else}}
from model.mantle_compat import MantleCompatResponsesModel
{{/if}}
{{/if}}

MODEL_ID = "{{modelId}}"


def load_model():
    """
    Get a Bedrock Mantle model client. These OpenAI-compatible models (e.g. openai.gpt-5.5,
    openai.gpt-oss-120b) are served via the Bedrock Mantle endpoint, NOT the Converse API — so they
    are invoked through an OpenAI-style client authenticated with a short-lived Bedrock bearer token.
    Region is read from AWS_REGION (set by the AgentCore runtime).
    """
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    token = provide_token(region=region)
    {{#if mantleProprietary}}
    # Proprietary OpenAI models only work on the /openai/v1 Mantle path.
    base_url = f"https://bedrock-mantle.{region}.api.aws/openai/v1"
    {{else}}
    # Open-source OpenAI models (gpt-oss-*) only work on the /v1 Mantle path.
    base_url = f"https://bedrock-mantle.{region}.api.aws/v1"
    {{/if}}
    client_args = {"api_key": token, "base_url": base_url}

    params = {}
    {{#if modelMaxTokens}}
    {{#if (eq mantleApiFormat "chat_completions")}}
    params["max_completion_tokens"] = {{modelMaxTokens}}
    {{else}}
    params["max_output_tokens"] = {{modelMaxTokens}}
    {{/if}}
    {{/if}}
    {{#if modelTemperature}}
    params["temperature"] = {{modelTemperature}}
    {{/if}}
    {{#if modelTopP}}
    params["top_p"] = {{modelTopP}}
    {{/if}}
    {{#if (eq mantleApiFormat "chat_completions")}}
    return OpenAIModel(client_args=client_args, model_id=MODEL_ID, params=params)
    {{else}}
    # Responses API: Mantle does not persist responses, so disable server-side storage.
    params["store"] = False
    {{#if mantleProprietary}}
    return OpenAIResponsesModel(client_args=client_args, model_id=MODEL_ID, params=params)
    {{else}}
    return MantleCompatResponsesModel(client_args=client_args, model_id=MODEL_ID, params=params)
    {{/if}}
    {{/if}}
{{else}}
from strands.models.bedrock import BedrockModel


def load_model() -> BedrockModel:
    """Get Bedrock model client using IAM credentials."""
    return BedrockModel(model_id="{{#if modelId}}{{modelId}}{{else}}global.anthropic.claude-sonnet-4-5-20250929-v1:0{{/if}}"{{#if modelMaxTokens}}, max_tokens={{modelMaxTokens}}{{/if}})
{{/if}}
{{/if}}
{{#if (eq modelProvider "Anthropic")}}
import os

from strands.models.anthropic import AnthropicModel
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


def load_model() -> AnthropicModel:
    """Get authenticated Anthropic model client."""
    return AnthropicModel(
        client_args={"api_key": _get_api_key()},
        model_id="claude-sonnet-4-5-20250929",
        max_tokens=5000,
    )
{{/if}}
{{#if (eq modelProvider "OpenAI")}}
import os

from strands.models.openai import OpenAIModel
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


def load_model() -> OpenAIModel:
    """Get authenticated OpenAI model client."""
    return OpenAIModel(
        client_args={"api_key": _get_api_key()},
        model_id="{{#if modelId}}{{modelId}}{{else}}gpt-4.1{{/if}}",
    )
{{/if}}
{{#if (eq modelProvider "Gemini")}}
import os

from strands.models.gemini import GeminiModel
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


def load_model() -> GeminiModel:
    """Get authenticated Gemini model client."""
    return GeminiModel(
        client_args={"api_key": _get_api_key()},
        model_id="{{#if modelId}}{{modelId}}{{else}}gemini-2.5-flash{{/if}}",
    )
{{/if}}
{{#if (eq modelProvider "LiteLLM")}}
import os
{{#if litellmAdditionalParams}}
import json
{{/if}}

from strands.models.litellm import LiteLLMModel
{{#if identityProviders.[0].name}}
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
{{/if}}




def load_model() -> LiteLLMModel:
    """Get a LiteLLM model client (proxies to the provider encoded in model_id)."""
    client_args = {}
    {{#if identityProviders.[0].name}}
    client_args["api_key"] = _get_api_key()
    {{/if}}
    {{#if litellmApiBase}}
    client_args["api_base"] = {{safeJson litellmApiBase}}
    {{/if}}
    params = {{#if litellmAdditionalParams}}json.loads({{pyJsonStr litellmAdditionalParams}}){{else}}{}{{/if}}
    return LiteLLMModel(
        client_args=client_args,
        model_id="{{#if modelId}}{{modelId}}{{else}}bedrock/us.anthropic.claude-sonnet-4-5-20250514-v1:0{{/if}}",
        params=params,
    )
{{/if}}
