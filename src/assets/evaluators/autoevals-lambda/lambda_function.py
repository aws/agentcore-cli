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

client = LiteLLMClient()
init(client=client, default_model="bedrock/{{ Model }}")

adapter = AutoEvalsAdapter(metric={{ EvaluatorClass }}(client=client, model="bedrock/{{ Model }}"){{#if EvaluatorParams}}, {{{ EvaluatorParams }}}{{/if}})
{{else}}
from autoevals import {{ EvaluatorClass }}

from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    EvaluatorInput,
    EvaluatorOutput,
    custom_code_based_evaluator,
)
from bedrock_agentcore.evaluation.custom_code_based_evaluators.third_party.autoevals import AutoEvalsAdapter

adapter = AutoEvalsAdapter(metric={{ EvaluatorClass }}({{#if Model}}model="{{ Model }}"{{/if}}){{#if EvaluatorParams}}, {{{ EvaluatorParams }}}{{/if}})
{{/if}}


@custom_code_based_evaluator()
def handler(evaluator_input: EvaluatorInput, context) -> EvaluatorOutput:
    return adapter(evaluator_input, context)
