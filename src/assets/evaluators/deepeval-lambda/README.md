# {{ Name }}

An AgentCore **code-based evaluator** backed by
[DeepEval](https://docs.confident-ai.com/) — scores each session with DeepEval's
`{{ EvaluatorClass }}` metric, judged by Amazon Bedrock.

## What's here

- `lambda_function.py` — wraps `{{ EvaluatorClass }}` in a `DeepEvalAdapter`
  behind the standard `@custom_code_based_evaluator()` handler.
- `pyproject.toml` — DeepEval + Bedrock dependencies, managed with
  [uv](https://docs.astral.sh/uv/).
- `execution-role-policy.json` — grants the Lambda `bedrock:InvokeModel` for the
  judge model; add more if your metric needs it.

## Customize

- Swap the metric or tune its threshold in `lambda_function.py`.
- Some DeepEval metrics need retrieval context or a reference/expected output —
  supply those when you invoke the evaluator, or the metric returns
  `MISSING_REQUIRED_FIELD`.

`agentcore project deploy` packages this directory into the evaluator Lambda.
