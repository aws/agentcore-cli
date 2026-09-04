from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"


def load_model() -> BaseChatModel:
    """Get a Bedrock chat model using IAM credentials."""
    return init_chat_model(MODEL_ID, model_provider="bedrock_converse")
