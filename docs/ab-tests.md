# A/B Tests

A/B tests split live traffic through a gateway between a **control** variant and a **treatment** variant, then use
online evaluation configs to measure which performs better. When you have a winner, `promote` applies it to your project
config.

A/B tests are **fire-and-forget jobs** (like `run recommendation` and `run batch-evaluation`): you start one with
`run ab-test`, then manage its lifecycle with `view` / `pause` / `resume` / `stop` / `promote` / `archive`. They are
**not** declared in `agentcore.json` and are not created by `deploy` — the gateway, its targets, and any config bundles
must already be deployed first.

## Two modes

| Mode                      | Compares                                    | Variant inputs                                                                                             |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `config-bundle` (default) | Two **versions of the same config bundle**  | `--control-bundle`/`--control-version`, `--treatment-bundle`/`--treatment-version`, shared `--online-eval` |
| `target-based`            | Two **gateway targets** (runtime endpoints) | `--control-target`/`--treatment-target`, `--control-online-eval`/`--treatment-online-eval`                 |

Each A/B test needs its **own gateway**, and only one test can be RUNNING per gateway at a time.

## Quick Start

```bash
# Config-bundle mode: compare two versions of one bundle (50/50 split)
agentcore run ab-test \
  -n PromptTest \
  -g MyGateway \
  --mode config-bundle \
  -r MyAgent \
  --control-bundle MyBundle --control-version <v1> \
  --treatment-bundle MyBundle --treatment-version <v2> \
  --online-eval MyEvalConfig

# Target-based mode: compare two gateway targets
agentcore run ab-test \
  -n TargetTest \
  -g MyGateway \
  --mode target-based \
  -r MyAgent \
  --control-target prodTarget \
  --treatment-target stagingTarget \
  --control-online-eval ctrlEval \
  --treatment-online-eval treatEval
```

A test is enabled (RUNNING) on create by default. Pass `--disable-on-create` to create it stopped.

## `run ab-test` options

| Flag                             | Description                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `-n, --name <name>`              | Name for the A/B test                                                                       |
| `-g, --gateway <name>`           | Gateway name (must already be deployed)                                                     |
| `-m, --mode <mode>`              | `config-bundle` (default) or `target-based`                                                 |
| `-r, --runtime <name>`           | Runtime name (recorded as the agent)                                                        |
| `--control-weight <n>`           | Control traffic weight 0–100 (default 50)                                                   |
| `--treatment-weight <n>`         | Treatment traffic weight 0–100 (default 50)                                                 |
| `--max-duration-days <days>`     | Auto-stop the test after this many days                                                     |
| `--role-arn <arn>`               | Execution role ARN (auto-created if omitted)                                                |
| `--disable-on-create`            | Create the test without starting it (default: enabled)                                      |
| `--gateway-filter <path>`        | Restrict the test to a single gateway target path (e.g. `/orders/*`); applies to both modes |
| `--region <region>`              | AWS region (auto-detected if omitted)                                                       |
| `--wait`                         | Block until the test reaches a terminal state                                               |
| `--json`                         | JSON output                                                                                 |
| **config-bundle mode**           |                                                                                             |
| `--control-bundle <name>`        | Control bundle name or ARN                                                                  |
| `--control-version <version>`    | Control bundle version (or `LATEST`)                                                        |
| `--treatment-bundle <name>`      | Treatment bundle name or ARN                                                                |
| `--treatment-version <version>`  | Treatment bundle version (or `LATEST`)                                                      |
| `--online-eval <name>`           | Shared online eval config name or ARN                                                       |
| `--traffic-header <name>`        | Route traffic on this header instead of by weight                                           |
| **target-based mode**            |                                                                                             |
| `--control-target <name>`        | Control gateway-target name                                                                 |
| `--treatment-target <name>`      | Treatment gateway-target name                                                               |
| `--control-online-eval <name>`   | Online eval for the control endpoint (required)                                             |
| `--treatment-online-eval <name>` | Online eval for the treatment endpoint (required)                                           |

Names must start with a letter and contain only letters, digits, underscores, and hyphens (max 48 characters).

## Lifecycle

All lifecycle commands take the test's **job ID** via `-i, --id` (get it from `run ab-test --json` or `view ab-test`):

```bash
# List all A/B test jobs, or view one in detail
agentcore view ab-test
agentcore view ab-test <id> --json

# Pause / resume traffic splitting
agentcore pause ab-test -i <id>
agentcore resume ab-test -i <id>

# Stop the test (terminal)
agentcore stop ab-test -i <id>

# Apply the winning variant to agentcore.json, then deploy to roll it out
agentcore promote ab-test -i <id>
agentcore deploy

# Remove the job from local history (and the test from the service)
agentcore archive ab-test -i <id>
```

### Promote

`promote` writes the winning (treatment) variant into `agentcore.json`:

- **config-bundle mode** — control and treatment must be two **versions of the same bundle**; promote adopts the
  treatment version's components into that bundle. Promoting across two _different_ bundles is rejected.
- **target-based mode** — control adopts the treatment endpoint: when both are named endpoints of the same runtime,
  control's endpoint version is bumped to the treatment's; otherwise the control target is repointed to the treatment's
  runtime/endpoint.

Promote does not deploy — review the change and run `agentcore deploy` to roll it out.

## Invocation URL

`view ab-test <id>` shows a URL derived from the test's gateway. Send traffic there and the gateway splits it between
the variants per the configured weights:

```
https://<gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com/<gateway-target>/invocations
```

The path segment is always a **gateway target** name — never a runtime name. Config-bundle tests carry no target of
their own (their variants are configuration bundles), so the CLI resolves the gateway target(s) fronting the `--runtime`
under test when the test is created:

- **one matching target** (the common case, including target-based tests) — a complete **Invocation URL**.
- **several matching targets** (e.g. a canary beside prod) — one **Invocation URL** per target; pick the one to send
  traffic to.
- **no matching target** — the **Gateway URL** only; append `/<gateway-target>/invocations` yourself, using
  `agentcore status --json` to list the gateway's targets.

With `--json` the field mirrors these cases: `invocationUrl` (single), `invocationUrlCandidates` (several), or
`gatewayUrl` + `invocationUrlHint` (none).

## Results

`view ab-test <id>` shows, once the online evals have scored enough traffic, per-evaluator metrics: the control mean,
each treatment's mean with percent change, and a significance marker. `--json` includes the same under
`results.evaluatorMetrics`, plus `status`, `executionStatus`, `variants`, and `invocationUrl`.

## Local history

Job records are saved under `.cli/jobs/ab-tests/`. Browse them in the TUI:

```bash
agentcore
# Navigate to: Run → A/B Tests   (or View → A/B Tests)
```

## TUI Wizard

Run `agentcore` → Run → A/B Test for a guided flow:

1. Select mode (config-bundle or target-based)
2. Select the gateway
3. Pick control + treatment variants (bundle versions, or gateway targets)
4. Select online eval config(s)
5. Optionally set a gateway filter
6. Name the test and confirm

Selecting a test from the A/B Tests list shows its detail (status, variants, invocation URL, results) with keybindings
to pause/resume/stop/promote/debug.
