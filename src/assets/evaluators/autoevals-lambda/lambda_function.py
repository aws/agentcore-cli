{{#if ModelProviderBedrock}}
import os

# litellm's Bedrock provider reads AWS_REGION_NAME; Lambda only sets AWS_REGION/AWS_DEFAULT_REGION.
os.environ.setdefault("AWS_REGION_NAME", os.environ.get("AWS_REGION", "us-west-2"))

from autoevals import {{ EvaluatorClass }}, init
from autoevals.litellm import LiteLLMClient

from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    EvaluatorInput,
    EvaluatorOutput,
    custom_code_based_evaluator,
)
from bedrock_agentcore.evaluation.custom_code_based_evaluators.third_party.autoevals import AutoEvalsAdapter

# Autoevals grades via an OpenAI-compatible client. LiteLLMClient routes to Bedrock;
# litellm auto-routes Anthropic Claude models through the Converse API. Cross-region
# inference profiles (us.*/eu.*/apac.*) are required for on-demand invocation.
JUDGE_MODEL = os.environ.get("BEDROCK_MODEL_ID", "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")
init(client=LiteLLMClient(), default_model=JUDGE_MODEL)

adapter = AutoEvalsAdapter(metric={{ EvaluatorClass }}(client=LiteLLMClient(), model=JUDGE_MODEL), {{{ EvaluatorParams }}})
{{else}}
from autoevals import {{ EvaluatorClass }}

from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    EvaluatorInput,
    EvaluatorOutput,
    custom_code_based_evaluator,
)
from bedrock_agentcore.evaluation.custom_code_based_evaluators.third_party.autoevals import AutoEvalsAdapter

adapter = AutoEvalsAdapter(metric={{ EvaluatorClass }}(), {{{ EvaluatorParams }}})
{{/if}}


@custom_code_based_evaluator()
def handler(evaluator_input: EvaluatorInput, context) -> EvaluatorOutput:
    return adapter(evaluator_input, context)
