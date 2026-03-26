# Evaluations

AgentCore evaluations let you measure agent quality using LLM-as-a-Judge. Define custom evaluators with scoring rubrics,
run them on-demand against historical traces, or deploy online eval configs that automatically sample and score live
traffic.

## Concepts

| Concept               | Description                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Evaluator**         | A custom LLM judge defined in your project with instructions, model, and rating scale |
| **On-demand eval**    | One-off evaluation run against historical agent traces within a lookback window       |
| **Online eval**       | Continuous evaluation that samples a percentage of live agent requests                |
| **Builtin evaluator** | Pre-built evaluators provided by AgentCore (e.g. `Builtin.Faithfulness`)              |
| **Evaluation level**  | Granularity of evaluation: `SESSION`, `TRACE`, or `TOOL_CALL`                         |

### Evaluation Levels

| Level       | Description                                         |
| ----------- | --------------------------------------------------- |
| `SESSION`   | Overall quality across an entire conversation       |
| `TRACE`     | Per-turn accuracy of individual agent responses     |
| `TOOL_CALL` | Correctness of individual tool selections and usage |

### Score Interpretation

Scores range from **0 (worst) to 1 (best)**, normalized from the rating scale you define. For example, a score of `3` on
a 1–5 numerical scale produces a normalized score of `0.60`.

## Adding an Evaluator

```bash
# Interactive (TUI wizard)
agentcore add evaluator

# Non-interactive
agentcore add evaluator \
  --name ResponseQuality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Evaluate the agent response quality. Context: {context}" \
  --rating-scale 1-5-quality
```

| Flag                      | Description                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `--name <name>`           | Evaluator name (alphanumeric + underscore, max 48 chars)                                |
| `--level <level>`         | Evaluation level: `SESSION`, `TRACE`, `TOOL_CALL`                                       |
| `--model <model>`         | Bedrock model ID for the LLM judge                                                      |
| `--instructions <text>`   | Evaluation prompt (must include level-appropriate placeholders — see below)             |
| `--rating-scale <preset>` | Rating scale preset or custom format (default: `1-5-quality`)                           |
| `--config <path>`         | Path to evaluator config JSON (overrides `--model`, `--instructions`, `--rating-scale`) |
| `--json`                  | JSON output                                                                             |

> **Note**: `--instructions` is required in non-interactive mode unless `--config` is provided.

### Instruction Placeholders

Instructions must include at least one placeholder appropriate for the evaluation level. Placeholders are replaced with
actual data at evaluation time.

| Placeholder         | Available At              | Description                                           |
| ------------------- | ------------------------- | ----------------------------------------------------- |
| `{context}`         | SESSION, TRACE, TOOL_CALL | Full conversation history (user + assistant messages) |
| `{assistant_turn}`  | TRACE                     | The specific assistant response being evaluated       |
| `{available_tools}` | SESSION, TOOL_CALL        | List of tools the agent can call                      |
| `{tool_turn}`       | TOOL_CALL                 | The specific tool call and its result                 |

Example instructions by level:

```
# SESSION
Evaluate whether the agent fulfilled the user's request. Context: {context}

# TRACE
Rate the accuracy of this response. Context: {context}. Assistant turn: {assistant_turn}

# TOOL_CALL
Evaluate whether the correct tool was selected. Context: {context}. Tool turn: {tool_turn}
```

### Rating Scale Presets

| Preset ID          | Type        | Values                                                |
| ------------------ | ----------- | ----------------------------------------------------- |
| `1-5-quality`      | Numerical   | Poor(1), Fair(2), Good(3), Very Good(4), Excellent(5) |
| `1-3-simple`       | Numerical   | Low(1), Medium(2), High(3)                            |
| `pass-fail`        | Categorical | Pass, Fail                                            |
| `good-neutral-bad` | Categorical | Good, Neutral, Bad                                    |

You can also provide a custom scale inline:

```bash
# Custom numerical
--rating-scale "1:Bad:Fails criteria, 2:OK:Meets criteria, 3:Great:Exceeds criteria"

# Custom categorical
--rating-scale "Relevant:On topic and useful, Irrelevant:Off topic or unhelpful"
```

### Evaluator Configuration

Evaluators are stored in the `evaluators` array of `agentcore.json`:

```json
{
  "evaluators": [
    {
      "type": "CustomEvaluator",
      "name": "ResponseQuality",
      "level": "SESSION",
      "config": {
        "llmAsAJudge": {
          "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          "instructions": "Evaluate the agent response quality. Context: {context}",
          "ratingScale": {
            "numerical": [
              { "value": 1, "label": "Poor", "definition": "Fails to meet expectations" },
              { "value": 2, "label": "Fair", "definition": "Partially meets expectations" },
              { "value": 3, "label": "Good", "definition": "Meets expectations" },
              { "value": 4, "label": "Very Good", "definition": "Exceeds expectations" },
              { "value": 5, "label": "Excellent", "definition": "Far exceeds expectations" }
            ]
          }
        }
      }
    }
  ]
}
```

### Model Selection

Model availability varies by AWS region. Recommended models:

| Model             | Description                                 |
| ----------------- | ------------------------------------------- |
| Claude Sonnet 4.5 | Recommended — balanced speed and accuracy   |
| Claude Opus 4.5   | Most capable — best for complex evaluations |
| Claude Haiku 4.5  | Fastest — good for high-volume evaluations  |
| Amazon Nova Pro   | Strong reasoning                            |
| Amazon Nova Lite  | Fast and cost-effective                     |

---

## Running On-Demand Evaluations

Run evaluators against historical agent traces.

```bash
# Project mode — evaluate a project agent
agentcore run eval \
  --agent MyAgent \
  --evaluator ResponseQuality \
  --days 7

# Standalone mode — evaluate any agent by ARN
agentcore run eval \
  --agent-arn arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/abc123 \
  --evaluator-arn arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/eval123 \
  --region us-east-1

# Multiple evaluators
agentcore run eval \
  --agent MyAgent \
  --evaluator ResponseQuality Builtin.Faithfulness \
  --days 14

# Target specific session or trace
agentcore run eval \
  --agent MyAgent \
  --evaluator ResponseQuality \
  --session-id abc123 \
  --days 7
```

| Flag                         | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `-a, --agent <name>`         | Agent name from project config                           |
| `--agent-arn <arn>`          | Agent runtime ARN (standalone mode, no project required) |
| `-e, --evaluator <names...>` | Evaluator name(s) from project or `Builtin.*` IDs        |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s) (use with `--agent-arn`)                |
| `--region <region>`          | AWS region (required with `--agent-arn`)                 |
| `-s, --session-id <id>`      | Evaluate a specific session only                         |
| `-t, --trace-id <id>`        | Evaluate a specific trace only                           |
| `--days <days>`              | Lookback window in days (default: 7)                     |
| `--output <path>`            | Custom output file path                                  |
| `--json`                     | JSON output                                              |

> **Note**: Traces may take 5–10 minutes to appear after agent invocations. If a run returns no sessions, try increasing
> `--days` or waiting for traces to propagate.

### TUI Wizard

In the TUI (`agentcore` → Evals → Run Evaluation), the wizard walks you through:

1. Select agent (or enter ARN)
2. Choose evaluator(s)
3. Set lookback window
4. Select sessions to evaluate
5. Confirm and run

### Viewing Results

Results are saved locally and can be viewed in the TUI or CLI:

```bash
# CLI table view
agentcore evals history

# Filter by agent
agentcore evals history --agent MyAgent

# JSON output
agentcore evals history --json --limit 10
```

| Flag                  | Description                   |
| --------------------- | ----------------------------- |
| `-a, --agent <name>`  | Filter by agent name          |
| `-n, --limit <count>` | Max number of runs to display |
| `--json`              | JSON output                   |

Results are stored in `agentcore/.cli/eval-runs/` within your project directory.

---

## Online Evaluations

Online eval configs automatically sample and evaluate a percentage of live agent requests after deployment.

### Adding an Online Eval Config

```bash
# Interactive
agentcore add online-eval

# Non-interactive
agentcore add online-eval \
  --name QualityMonitor \
  --agent MyAgent \
  --evaluator ResponseQuality Builtin.Faithfulness \
  --sampling-rate 10
```

| Flag                         | Description                                           |
| ---------------------------- | ----------------------------------------------------- |
| `--name <name>`              | Config name (alphanumeric + underscore, max 48 chars) |
| `-a, --agent <name>`         | Agent to monitor                                      |
| `-e, --evaluator <names...>` | Evaluator name(s), `Builtin.*` IDs, or ARNs           |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s)                                      |
| `--sampling-rate <rate>`     | Percentage of requests to evaluate (0.01–100)         |
| `--enable-on-create`         | Enable immediately after deploy                       |
| `--json`                     | JSON output                                           |

### Sampling Rate

The sampling rate controls what percentage of agent requests are evaluated. Higher rates give better coverage but
increase LLM costs from evaluator invocations.

| Rate   | Use Case                              |
| ------ | ------------------------------------- |
| 1–5%   | Production monitoring, cost-sensitive |
| 10–25% | Development and staging               |
| 100%   | Full coverage during testing          |

### Online Eval Configuration

Online eval configs are stored in the `onlineEvalConfigs` array of `agentcore.json`:

```json
{
  "onlineEvalConfigs": [
    {
      "type": "OnlineEvaluationConfig",
      "name": "QualityMonitor",
      "agent": "MyAgent",
      "evaluators": ["ResponseQuality", "Builtin.Faithfulness"],
      "samplingRate": 10,
      "enableOnCreate": true
    }
  ]
}
```

Run `agentcore deploy` to create or update the online eval config in AWS.

### Pause and Resume

```bash
# Pause by name (requires project)
agentcore pause online-eval QualityMonitor

# Resume by name
agentcore resume online-eval QualityMonitor

# Pause by ARN (no project required)
agentcore pause online-eval --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:online-eval-config/abc123

# Resume by ARN
agentcore resume online-eval --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:online-eval-config/abc123
```

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `[name]`            | Config name from project (not needed with `--arn`) |
| `--arn <arn>`       | Online eval config ARN (standalone mode)           |
| `--region <region>` | AWS region override                                |
| `--json`            | JSON output                                        |

### Online Eval Dashboard

The TUI provides a dashboard for monitoring online eval results (`agentcore` → Evals → Online Eval Dashboard).

> **Note**: Evaluation results may take 5–10 minutes to appear after agent invocations.

### Viewing Online Eval Logs

```bash
# Stream logs in real-time
agentcore logs evals

# Search historical logs
agentcore logs evals --agent MyAgent --since 1h

# JSON output
agentcore logs evals --json --lines 100
```

| Flag                  | Description                                   |
| --------------------- | --------------------------------------------- |
| `-a, --agent <name>`  | Filter by agent                               |
| `--since <time>`      | Start time (e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`      | End time (e.g. `now`, ISO 8601)               |
| `-n, --lines <count>` | Maximum number of log lines                   |
| `-f, --follow`        | Stream logs in real-time                      |
| `--json`              | JSON Lines output                             |

---

## Removing Eval Resources

```bash
# Remove an evaluator
agentcore remove evaluator --name ResponseQuality

# Remove an online eval config
agentcore remove online-eval --name QualityMonitor
```

> **Note**: You cannot remove an evaluator that is referenced by an online eval config. Remove the online eval config
> reference first.

---

## Builtin Evaluators

AgentCore provides pre-built evaluators that can be used without creating custom evaluator definitions. Reference them
by their `Builtin.*` ID in `--evaluator` flags or in online eval config `evaluators` arrays.

```bash
agentcore run eval --agent MyAgent --evaluator Builtin.Faithfulness
```

---

## Common Patterns

### CI/CD Quality Gate

```bash
# Run eval and fail pipeline if score < threshold
result=$(agentcore run eval --agent MyAgent --evaluator ResponseQuality --days 1 --json)
score=$(echo "$result" | jq '.run.results[0].aggregateScore')
if (( $(echo "$score < 0.7" | bc -l) )); then
  echo "Quality gate failed: score $score < 0.7"
  exit 1
fi
```

### Full Evaluation Setup

```bash
# 1. Create evaluator
agentcore add evaluator \
  --name ResponseQuality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Evaluate the agent response quality. Context: {context}"

# 2. Run on-demand eval to verify
agentcore run eval --agent MyAgent --evaluator ResponseQuality --days 7

# 3. Set up continuous monitoring
agentcore add online-eval \
  --name QualityMonitor \
  --agent MyAgent \
  --evaluator ResponseQuality \
  --sampling-rate 10

# 4. Deploy
agentcore deploy
```

### Standalone Mode (No Project)

Evaluate agents and use evaluators outside of a project directory using ARNs:

```bash
agentcore run eval \
  --agent-arn arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent \
  --evaluator-arn arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/my-eval \
  --region us-east-1 \
  --days 7

agentcore pause online-eval \
  --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:online-eval-config/my-config
```
