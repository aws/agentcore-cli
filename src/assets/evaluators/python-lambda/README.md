# {{ Name }}

An AgentCore **code-based evaluator** — a Lambda that scores an agent session
with your own logic.

## What's here

- `lambda_function.py` — the evaluator. The `@custom_code_based_evaluator()`
  handler receives an `EvaluatorInput` (the session / trace / tool-call to
  grade) and returns an `EvaluatorOutput` (`value` + `label`, or an error). It
  ships as a stub that returns `Pass` for everything — replace the `TODO` with
  your scoring logic.
- `pyproject.toml` — Python dependencies, managed with
  [uv](https://docs.astral.sh/uv/).
- `execution-role-policy.json` — extra IAM the evaluator Lambda gets at runtime.
  Add statements here for anything your logic calls (DynamoDB, S3, …).

## Write your evaluator

```python
@custom_code_based_evaluator()
def handler(input: EvaluatorInput, context) -> EvaluatorOutput:
    # inspect input.session_spans / input.target_trace_id / input.target_span_id
    return EvaluatorOutput(value=1.0, label="Pass", explanation="…")
```

Then `agentcore project deploy` packages this directory into the evaluator
Lambda and registers the evaluator.
