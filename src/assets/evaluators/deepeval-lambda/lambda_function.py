from bedrock_agentcore.evaluation.integrations.deepeval import DeepEvalHandler
from deepeval.metrics import {{ MetricClass }}

handler = DeepEvalHandler(metric={{ MetricClass }}({{{ MetricParams }}}))
