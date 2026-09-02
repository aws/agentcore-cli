# {{ Name }}

An AgentCore **code-based evaluator** backed by
[autoevals](https://github.com/braintrustdata/autoevals) — scores each session
with autoevals' `{{ EvaluatorClass }}` scorer.

## What's here

- `lambda_function.py` — wraps `{{ EvaluatorClass }}` in an `AutoEvalsAdapter`
  behind the standard `@custom_code_based_evaluator()` handler. With a Bedrock
  judge model set, autoevals grades via a LiteLLM client → Bedrock.
- `pyproject.toml` — autoevals + judge dependencies, managed with
  [uv](https://docs.astral.sh/uv/).
- `execution-role-policy.json` — grants the Lambda `bedrock:InvokeModel` for the
  judge model.

## Customize

- Change the scorer or its arguments in `lambda_function.py`.
- Scorers like `Factuality` / `ClosedQA` / `SQL` need an expected/reference
  output — provide it when you invoke the evaluator.

`agentcore project deploy` packages this directory into the evaluator Lambda.
