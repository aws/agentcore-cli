from bedrock_agentcore.evaluation.integrations.deepeval import DeepEvalAdapter
from deepeval.metrics import {{ EvaluatorClass }}

handler = DeepEvalAdapter(metric={{ EvaluatorClass }}({{{ EvaluatorParams }}}))
