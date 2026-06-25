from bedrock_agentcore.evaluation.integrations.autoevals import AutoevalsAdapter
from autoevals import {{ EvaluatorClass }}

handler = AutoevalsAdapter(scorer={{ EvaluatorClass }}({{{ EvaluatorParams }}}))
