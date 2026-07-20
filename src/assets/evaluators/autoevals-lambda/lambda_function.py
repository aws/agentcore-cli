from autoevals import {{ EvaluatorClass }}

from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    EvaluatorInput,
    EvaluatorOutput,
    custom_code_based_evaluator,
)
from bedrock_agentcore.evaluation.custom_code_based_evaluators.third_party.autoevals import AutoEvalsAdapter

adapter = AutoEvalsAdapter(metric={{ EvaluatorClass }}(), {{{ EvaluatorParams }}})


@custom_code_based_evaluator()
def handler(evaluator_input: EvaluatorInput, context) -> EvaluatorOutput:
    return adapter(evaluator_input, context)
