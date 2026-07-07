# Batch Evaluation

Batch evaluation runs evaluators across all agent sessions in CloudWatch, producing per-session scores and aggregate
metrics. Use it to measure agent quality over time, compare before/after prompt changes, or validate ground truth
expectations.

## Quick Start

```bash
# Run a single evaluator across all sessions
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness

# Multiple evaluators
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness Builtin.Helpfulness Builtin.Faithfulness

# Reference evaluators by ARN (custom or cross-account)
agentcore run batch-evaluation -r MyAgent --evaluator-arn arn:aws:bedrock-agentcore:us-west-2:123456789012:evaluator/MyCustomEval

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

## Dataset-Driven Evaluation

Instead of scoring historical CloudWatch traces, drive the evaluation from a **dataset** — the CLI invokes the agent
with each dataset scenario, then scores the results:

```bash
# Use the local DRAFT dataset file
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness --dataset MyScenarios

# Use a published dataset version
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness --dataset MyScenarios --dataset-version 1
```

| Flag                          | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `--dataset <name>`            | Dataset name — invoke the agent with its scenarios instead of traces |
| `--dataset-version <version>` | Dataset version (`N` or `DRAFT`; omit to use the local file)         |

Add and edit datasets with `agentcore add dataset` and `agentcore dataset publish-version`. The number of scored
sessions equals the number of scenarios in the dataset.

## Custom Name

```bash
agentcore run batch-evaluation -r MyAgent -e Builtin.Helpfulness -n "weekly_quality_check"
```

Names must start with a letter and contain only letters, digits, and underscores (max 48 characters).

## Encrypting Results with KMS

By default, batch evaluation results are encrypted with an AWS-managed key. To encrypt them with your own customer
managed key (CMK), pass its ARN with `--kms-key`:

```bash
agentcore run batch-evaluation \
  -r MyAgent \
  -e Builtin.Correctness \
  --kms-key arn:aws:kms:us-west-2:111122223333:key/12345678-1234-1234-1234-123456789012
```

The key must be in the same region as the evaluation, and the calling principal (and the AgentCore service) must have
`kms:Encrypt`/`kms:GenerateDataKey` permissions on it. Omit the flag to use the AWS-managed key.

## Stopping a Running Evaluation

```bash
agentcore stop batch-evaluation -i <batch-evaluation-id>
```

## Viewing Results

### CLI output

The CLI shows scores grouped by evaluator with average scores after the run completes.

### Local history

Job records are saved in `.cli/jobs/batch-eval-results/`. View past runs via the TUI:

```bash
agentcore
# Navigate to: Run → Batch Evaluation History   (or View → Batch Evaluation)
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
