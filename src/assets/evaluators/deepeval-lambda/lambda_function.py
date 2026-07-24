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
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")
REGION = os.environ.get("AWS_REGION", "us-west-2")

model = AmazonBedrockModel(model=MODEL_ID, region=REGION)
adapter = DeepEvalAdapter(metric={{ EvaluatorClass }}(model=model, {{{ EvaluatorParams }}}))
{{else}}
adapter = DeepEvalAdapter(metric={{ EvaluatorClass }}({{{ EvaluatorParams }}}))
{{/if}}


@custom_code_based_evaluator()
def handler(evaluator_input: EvaluatorInput, context) -> EvaluatorOutput:
    return adapter(evaluator_input, context)
