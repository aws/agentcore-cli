<div align="center">
  <h1>AgentCore CLI</h1>
  <p><strong>Create, develop, and deploy AI agents to Amazon Bedrock AgentCore</strong></p>

  <p>
    <a href="https://github.com/aws/agentcore-cli/actions/workflows/build-and-test.yml"><img src="https://img.shields.io/github/actions/workflow/status/aws/agentcore-cli/build-and-test.yml?branch=main&label=build" alt="Build Status"></a>
    <a href="https://www.npmjs.com/package/@aws/agentcore"><img src="https://img.shields.io/npm/v/@aws/agentcore" alt="npm version"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/aws/agentcore-cli" alt="License"></a>
  </p>
</div>

## Overview

Amazon Bedrock AgentCore enables you to deploy and operate AI agents securely at scale using any framework and model.
AgentCore provides tools and capabilities to make agents more effective, purpose-built infrastructure to securely scale
agents, and controls to operate trustworthy agents. This CLI helps you create, develop locally, and deploy agents to
AgentCore with minimal configuration.

## 🚀 Jump Into AgentCore

- **Node.js** 20.x or later
- **uv** for Python agents ([install](https://docs.astral.sh/uv/getting-started/installation/))

## Installation

> **Upgrading from the Bedrock AgentCore Starter Toolkit?** If the old Python CLI is still installed, you'll see a
> warning after install asking you to uninstall it. Both CLIs use the `agentcore` command name, so having both can cause
> confusion. Uninstall the old one using whichever tool you originally used:
>
> ```bash
> pip uninstall bedrock-agentcore-starter-toolkit    # if installed via pip
> pipx uninstall bedrock-agentcore-starter-toolkit   # if installed via pipx
> uv tool uninstall bedrock-agentcore-starter-toolkit # if installed via uv
> ```

```bash
npm install -g @aws/agentcore
```

## Quick Start

Use the terminal UI to walk through all commands interactively, or run each command individually:

```bash
# Launch terminal UI
agentcore

# Create a new project (wizard guides you through agent setup)
agentcore create
cd my-project

# Test locally
agentcore dev

# Deploy to AWS
agentcore deploy

# Test deployed agent
agentcore invoke

```

## Supported Frameworks

| Framework           | Notes                                               |
| ------------------- | --------------------------------------------------- |
| Strands Agents      | AWS-native, streaming support (Python + TypeScript) |
| LangChain/LangGraph | Graph-based workflows                               |
| Google ADK          | Gemini models only                                  |
| OpenAI Agents       | OpenAI models only                                  |

## Supported Model Providers

| Provider       | API Key Required          | Default Model                                |
| -------------- | ------------------------- | -------------------------------------------- |
| Amazon Bedrock | No (uses AWS credentials) | us.anthropic.claude-sonnet-4-5-20250514-v1:0 |
| Anthropic      | Yes                       | claude-sonnet-4-5-20250514                   |
| Google Gemini  | Yes                       | gemini-2.5-flash                             |
| OpenAI         | Yes                       | gpt-4.1                                      |

## Commands

### Project Lifecycle

| Command  | Description                    |
| -------- | ------------------------------ |
| `create` | Create a new AgentCore project |
| `dev`    | Start local development server |
| `deploy` | Deploy infrastructure to AWS   |
| `invoke` | Invoke deployed agents         |

### Resource Management

| Command  | Description                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`    | Add harnesses, agents, memory, credentials, gateways and gateway-targets, evaluators, online evals, online insights, knowledge bases, config bundles, datasets, policy engines and policies, payment managers and payment connectors, capacity providers, runtime endpoints |
| `remove` | Remove any of the above resources from the project                                                                                                                                                                                                                          |

> **Note**: Run `agentcore deploy` after `add` or `remove` to update resources in AWS.

### Harness

A harness bundles a runtime, model, tools, skills, memory, and observability into one declarative config. Use it when
you want infra without writing agent code.

| Command          | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `add harness`    | Add a harness resource (runtime + model + memory)                           |
| `add tool`       | Add a tool to a harness (`--harness <name> --type <type> --name <name>`)    |
| `add skill`      | Add a skill to a harness (`--harness <name>` + `--path` / `--s3` / `--git`) |
| `export harness` | Export a harness config to a deployable Strands Python agent under `app/`   |

> After `export harness`, **read `app/<agentName>/EXPORT_NOTES.md`** before running `deploy` — it lists any manual
> follow-up the exporter could not automate.

### Observability

| Command       | Description                             |
| ------------- | --------------------------------------- |
| `logs`        | Stream or search agent runtime logs     |
| `traces list` | List recent traces for a deployed agent |
| `traces get`  | Download a trace to a JSON file         |
| `status`      | Show deployed resource details          |

### Evaluations

| Command                 | Description                                   |
| ----------------------- | --------------------------------------------- |
| `add evaluator`         | Add a custom LLM-as-a-Judge evaluator         |
| `add online-eval`       | Add continuous evaluation for live traffic    |
| `run eval`              | Run on-demand evaluation against agent traces |
| `run batch-evaluation`  | Run evaluators across all sessions            |
| `run recommendation`    | Optimize prompts and tool descriptions        |
| `evals history`         | View past eval run results                    |
| `pause online-eval`     | Pause a deployed online eval config           |
| `resume online-eval`    | Resume a paused online eval config            |
| `stop batch-evaluation` | Stop a running batch evaluation               |
| `logs evals`            | Stream or search online eval logs             |

### Config Bundles

| Command             | Description                               |
| ------------------- | ----------------------------------------- |
| `add config-bundle` | Add a versioned configuration bundle      |
| `cb versions`       | List version history for a bundle         |
| `cb diff`           | Diff two versions of a bundle             |
| `cb create-branch`  | Create a new branch on an existing bundle |

> Create agents with `--with-config-bundle` to auto-wire config bundle support into the generated template.

### A/B Tests

| Command           | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `run ab-test`     | Start an A/B test (config-bundle or target-based) on a gateway |
| `view ab-test`    | List A/B test jobs or view one in detail                       |
| `pause ab-test`   | Pause traffic splitting for a running test                     |
| `resume ab-test`  | Resume a paused test                                           |
| `stop ab-test`    | Stop a running test (terminal)                                 |
| `promote ab-test` | Apply the winning variant to `agentcore.json`                  |
| `archive ab-test` | Delete the test on the service and clear local history         |

### Knowledge Bases

| Command              | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `add knowledge-base` | Add a managed Bedrock Knowledge Base wired to a gateway |

> See [Knowledge Bases](docs/knowledge-bases.md) for ingestion, vectorization, and retrieval setup.

### Insights — `[preview]`

Failure-pattern analysis across agent sessions. Insights configs run continuously alongside online evals and surface
clusters of bad outcomes.

| Command                  | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `add online-insights`    | Add a continuous insights config bound to a runtime         |
| `run insights`           | Run on-demand failure analysis across recent sessions       |
| `view insights`          | List insights jobs or view one in detail                    |
| `pause online-insights`  | Pause a deployed online insights config                     |
| `resume online-insights` | Resume a paused online insights config                      |
| `archive insights`       | Delete an insights job on the service + clear local history |

### Policies & Guardrails

Policy engines apply Cedar-based pre/post-call policies to agent invocations — including Bedrock content filters
(`VIOLENCE`, `HATE`, `SEXUAL`, `MISCONDUCT`, `INSULTS`), prompt-attack detection, and sensitive-information redaction.

| Command             | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `add policy-engine` | Add a Cedar policy engine to the project                             |
| `add policy`        | Add a policy to a policy engine (form-based guardrails or raw Cedar) |

### Payments

Pay-per-call agent transactions via the [x402 protocol](https://www.x402.org/). When a tool call returns
`402 Payment Required`, the payments system signs and submits payment then retries automatically.

| Command                 | Description                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `add payment-manager`   | Add a payment manager (orchestrates payment sessions for the agent)          |
| `add payment-connector` | Add a payment connector with provider credentials (CoinbaseCDP, StripePrivy) |

> See [Payments](docs/payments.md) for the full setup including instrument creation and tool allowlists.

### Datasets

Curated session datasets for batch evaluation and recommendation runs.

| Command                   | Description                                                               |
| ------------------------- | ------------------------------------------------------------------------- |
| `add dataset`             | Add a dataset resource (session list, ground-truth file, or trace filter) |
| `dataset download`        | Download a dataset version locally                                        |
| `dataset publish-version` | Publish a new dataset version                                             |
| `dataset remove-version`  | Remove a dataset version                                                  |

### Web Search Gateway Targets

Add a managed web-search target to a gateway:

```bash
agentcore add gateway-target --type connector --connector web-search \
  --gateway <gateway-name> --name <target-name>
# Optional: --exclude-domains "example.com,foo.org"
```

See [Gateway](docs/gateway.md) for full target setup including Lambda, MCP, OpenAPI, Smithy, and API Gateway.

### Utilities

| Command        | Description                                           |
| -------------- | ----------------------------------------------------- |
| `validate`     | Validate configuration files                          |
| `package`      | Package agent artifacts without deploying             |
| `fetch access` | Fetch access info for deployed resources              |
| `feedback`     | Send feedback to the AgentCore team (with screenshot) |
| `update`       | Check for and install CLI updates                     |

## Project Structure

```
my-project/
├── agentcore/
│   ├── .env.local          # API keys (gitignored)
│   ├── agentcore.json      # Resource specifications
│   ├── aws-targets.json    # Deployment targets
│   └── cdk/                # CDK infrastructure
├── app/                    # Application code
```

### App Structure

```
├── app/                    # Application code
│   └── <AgentName>/        # Agent directory
│       ├── main.py         # Agent entry point
│       ├── pyproject.toml  # Python dependencies
│       └── model/          # Model configuration
```

## Configuration

Projects use JSON schema files in the `agentcore/` directory:

- `agentcore.json` - Project resources (agents, memory, credentials, gateways, evaluators, online evals/insights,
  knowledge bases, harnesses, policy engines and policies, payment managers and connectors, capacity providers, config
  bundles, datasets, runtime endpoints)
- `deployed-state.json` - Runtime state in agentcore/.cli/ (auto-managed)
- `aws-targets.json` - Deployment targets (account, region)

## Capabilities

- **Harness** - Declarative agent: bundle runtime + tools + skills + memory + observability without writing agent code
- **Runtime** - Managed execution environment for deployed agents
- **Memory** - Semantic, summarization, user-preference, and episodic strategies
- **Credentials** - Secure API key + OAuth credential management via Secrets Manager
- **Gateways** - MCP gateways with Lambda / MCP server / OpenAPI / Smithy / API Gateway / **web-search** /
  **knowledge-base** targets
- **Evaluations** - LLM-as-a-Judge for on-demand, batch, and continuous agent quality monitoring
- **Recommendations** - Auto-optimize system prompts and tool descriptions from real session traces
- **A/B Tests** - Traffic-split between config-bundle or target-based variants and promote the winner
- **Insights** _[preview]_ - Failure-pattern analysis and clustering across agent sessions
- **Knowledge Bases** - Managed Bedrock Knowledge Bases auto-wired to gateways
- **Policies & Guardrails** - Cedar pre/post-call policies including Bedrock content filters, prompt-attack detection,
  and sensitive-information redaction
- **Payments** - x402-protocol microtransactions for pay-per-call tools and APIs
- **Config Bundles** - Versioned runtime configurations as a separately-deployable resource

## Documentation

**Reference**

- [CLI Commands Reference](docs/commands.md) - Full command reference for scripting and CI/CD
- [Configuration](docs/configuration.md) - Schema reference for config files
- [Frameworks](docs/frameworks.md) - Supported frameworks and model providers
- [PERMISSIONS](docs/PERMISSIONS.md) - IAM permissions required to deploy

**Resources & features**

- [Memory](docs/memory.md) - Memory strategies and sharing
- [Gateway](docs/gateway.md) - Gateway setup, targets, and authentication
- [Knowledge Bases](docs/knowledge-bases.md) - Managed Bedrock Knowledge Bases wired to gateways
- [Payments](docs/payments.md) - x402-protocol microtransactions for paid tools/APIs
- [Config Bundles](docs/config-bundles.md) - Versioned runtime configurations
- [Container Builds](docs/container-builds.md) - Container build types and Dockerfile setup

**Evaluation & quality**

- [Evaluations](docs/evals.md) - Evaluators, on-demand evals, and online monitoring
- [Batch Evaluation](docs/batch-evaluation.md) - Run evaluators across sessions at scale
- [Recommendations](docs/recommendations.md) - Optimize prompts and tool descriptions
- [A/B Tests](docs/ab-tests.md) - Split traffic between variants and promote the winner

**Operations**

- [Local Development](docs/local-development.md) - Dev server and debugging
- [Transaction Search](docs/transaction_search.md) - Trace + log search across agent invocations
- [Telemetry](docs/telemetry.md) - CLI usage telemetry — what's collected and how to opt out
- [TUI Harness](docs/tui-harness.md) - Programmatic TUI driver for testing
- [Testing](docs/TESTING.md) - Unit, integration, and e2e test infrastructure
- [Feedback](docs/feedback.md) - Submit feedback from your terminal

## Examples

See the [AgentCore Samples](https://github.com/awslabs/agentcore-samples) repository for end-to-end examples using the
CLI, including multi-agent workflows, MCP gateway targets, and framework integrations.

## Feedback & Issues

Have a quick comment or suggestion? Send it from your terminal:

```bash
agentcore feedback "your message" --screenshot path/to/screenshot.png
```

The CLI will display the AWS Customer Agreement and prompt for consent before submitting. See
[docs/feedback.md](docs/feedback.md) for usage details.

For bugs, regressions, or feature requests that need discussion,
[open an issue](https://github.com/aws/agentcore-cli/issues/new) on GitHub instead.

## Security

See [SECURITY](SECURITY.md) for reporting vulnerabilities and security information.

## License

This project is licensed under the Apache-2.0 License.
