import os

os.environ.setdefault("DEEPEVAL_RESULTS_FOLDER", "/tmp/.deepeval")
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
os.chdir("/tmp")

{{#if ModelProviderBedrock}}
from deepeval.models import AmazonBedrockModel
{{/if}}
from deepeval.metrics import {{ EvaluatorClass }}

from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    EvaluatorInput,
    EvaluatorOutput,
    custom_code_based_evaluator,
)
from bedrock_agentcore.evaluation.custom_code_based_evaluators.third_party.deepeval import DeepEvalAdapter

{{#if ModelProviderBedrock}}
model = AmazonBedrockModel(model="{{ Model }}", region=os.environ.get("AWS_REGION", "us-west-2"))
adapter = DeepEvalAdapter(metric={{ EvaluatorClass }}(model=model{{#if EvaluatorParams}}, {{{ EvaluatorParams }}}{{/if}}))
{{else}}
adapter = DeepEvalAdapter(metric={{ EvaluatorClass }}({{{ EvaluatorParams }}}))
{{/if}}


@custom_code_based_evaluator()
def handler(evaluator_input: EvaluatorInput, context) -> EvaluatorOutput:
    return adapter(evaluator_input, context)
