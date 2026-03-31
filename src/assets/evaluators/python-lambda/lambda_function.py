from bedrock_agentcore.evaluation.custom_code_based_evaluators import (
    custom_code_based_evaluator,
    EvaluatorInput,
    EvaluatorOutput,
)


@custom_code_based_evaluator()
def handler(input: EvaluatorInput, context) -> EvaluatorOutput:
    """Evaluate agent behavior with custom logic.

    Args:
        input: Contains evaluation_level, session_spans, target_trace_id, target_span_id

    Returns:
        EvaluatorOutput with value/label for success, or errorCode/errorMessage for failure.
    """
    # TODO: Replace with your evaluation logic
    return EvaluatorOutput(value=1.0, label="Pass", explanation="Evaluation passed")
