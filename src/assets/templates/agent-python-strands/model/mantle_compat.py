from strands.models.openai_responses import OpenAIResponsesModel


class MantleCompatResponsesModel(OpenAIResponsesModel):
    """Workaround for Bedrock Mantle rejecting output_text in EasyInputMessage content arrays.

    Mantle's Pydantic validation only accepts content as a plain string for assistant messages, while
    real OpenAI accepts both formats. Flatten assistant content arrays to strings so multi-turn works.
    Used for open-source OpenAI models (gpt-oss-*) on the /v1 Mantle path; proprietary models use the
    plain OpenAIResponsesModel on /openai/v1.
    """

    @classmethod
    def _format_request_messages(cls, messages):
        formatted = super()._format_request_messages(messages)
        for msg in formatted:
            if msg.get("role") == "assistant" and isinstance(msg.get("content"), list):
                msg["content"] = "".join(
                    part.get("text", "") for part in msg["content"] if part.get("type") == "output_text"
                )
        return formatted
