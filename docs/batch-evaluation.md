# Batch Evaluation [preview]

Batch evaluation runs evaluators across all agent sessions in CloudWatch, producing per-session scores and aggregate
metrics. Use it to measure agent quality over time, compare before/after prompt changes, or validate ground truth
expectations.

## Quick Start

```bash
# Run a single evaluator across all sessions
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness

# Multiple evaluators
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness Builtin.Helpfulness Builtin.Faithfulness

# JSON output for scripting
agentcore run batch-evaluation -r MyAgent -e Builtin.Helpfulness --json
```

## Available Evaluators

Built-in evaluators provided by AgentCore:

| Evaluator                           | What it measures                               |
| ----------------------------------- | ---------------------------------------------- |
| `Builtin.Correctness`               | Factual accuracy of responses                  |
| `Builtin.Helpfulness`               | How well responses address the user's goal     |
| `Builtin.Faithfulness`              | Grounding in tool results / provided context   |
| `Builtin.GoalSuccessRate`           | Whether the agent achieved the user's goal     |
| `Builtin.ToolSelectionAccuracy`     | Correct tool chosen for the task               |
| `Builtin.Completeness`              | Whether all parts of the request were handled  |
| `Builtin.TrajectoryExactOrderMatch` | Tool call sequence matches expected trajectory |

Custom evaluators defined in your project (via `agentcore add evaluator`) can also be used.

## Filtering Sessions

### By time window

```bash
# Only sessions from the last 3 days
agentcore run batch-evaluation -r MyAgent -e Builtin.Helpfulness --lookback-days 3
```

### By session ID

```bash
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness -s <session-id-1> <session-id-2>
```

## Ground Truth

Provide expected responses, assertions, or expected tool trajectories for specific sessions:

```bash
agentcore run batch-evaluation \
  -r MyAgent \
  -e Builtin.Correctness Builtin.GoalSuccessRate \
  -s <session-id> \
  --ground-truth ./ground_truth.json
```

### Ground truth file format

```json
[
  {
    "sessionId": "<session-id>",
    "groundTruth": {
      "inline": {
        "assertions": [{ "text": "Agent should use the lookup_order tool" }],
        "expectedTrajectory": {
          "toolNames": ["lookup_order"]
        },
        "turns": [
          {
            "input": "What's the status of order ORD-1001?",
            "expectedResponse": { "text": "Order ORD-1001 has been delivered" }
          }
        ]
      }
    }
  }
]
```

All fields inside `inline` are optional — include only what's relevant:

- `assertions` — free-text expectations evaluated by `Builtin.GoalSuccessRate`
- `expectedTrajectory` — tool call sequence evaluated by `Builtin.TrajectoryExactOrderMatch`
- `turns` — input/expected-response pairs evaluated by `Builtin.Correctness`

## Custom Name

```bash
agentcore run batch-evaluation -r MyAgent -e Builtin.Helpfulness -n "weekly_quality_check"
```

Names must start with a letter and contain only letters, digits, and underscores (max 48 characters).

## Stopping a Running Evaluation

```bash
agentcore stop batch-evaluation -i <batch-evaluation-id>
```

## Viewing Results

### CLI output

The CLI shows scores grouped by evaluator with average scores after the run completes.

### Local history

Results are saved in `.cli/eval-job-results/`. View past runs via the TUI:

```bash
agentcore
# Navigate to: Evals → Batch Evaluation History
```

### JSON output

```bash
agentcore run batch-evaluation -r MyAgent -e Builtin.Helpfulness --json
```

Returns `batchEvaluationId`, `evaluationResults` with `numberOfSessionsCompleted`, `evaluatorSummaries` with
per-evaluator `averageScore`.

## TUI Wizard

Run `agentcore` → Run → Batch Evaluation for a guided flow:

1. Select agent
2. Multi-select evaluators
3. Set lookback days
4. Optionally select specific sessions
5. Optionally add ground truth
6. Name the run (optional)
7. Confirm and run

The TUI shows real-time progress with elapsed time and step indicators.
