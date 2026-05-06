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

| Framework           | Notes                         |
| ------------------- | ----------------------------- |
| Strands Agents      | AWS-native, streaming support |
| LangChain/LangGraph | Graph-based workflows         |
| Google ADK          | Gemini models only            |
| OpenAI Agents       | OpenAI models only            |

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

| Command  | Description                                          |
| -------- | ---------------------------------------------------- |
| `add`    | Add agents, memory, credentials, evaluators, targets |
| `remove` | Remove resources from project                        |

> **Note**: Run `agentcore deploy` after `add` or `remove` to update resources in AWS.

### Observability

| Command       | Description                             |
| ------------- | --------------------------------------- |
| `logs`        | Stream or search agent runtime logs     |
| `traces list` | List recent traces for a deployed agent |
| `traces get`  | Download a trace to a JSON file         |
| `status`      | Show deployed resource details          |

### Evaluations

| Command                 | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `add evaluator`         | Add a custom LLM-as-a-Judge evaluator            |
| `add online-eval`       | Add continuous evaluation for live traffic       |
| `run eval`              | Run on-demand evaluation against agent traces    |
| `run batch-evaluation`  | Run evaluators across all sessions [preview]     |
| `run recommendation`    | Optimize prompts and tool descriptions [preview] |
| `evals history`         | View past eval run results                       |
| `pause online-eval`     | Pause a deployed online eval config              |
| `resume online-eval`    | Resume a paused online eval config               |
| `stop batch-evaluation` | Stop a running batch evaluation [preview]        |
| `logs evals`            | Stream or search online eval logs                |

### Config Bundles [preview]

| Command             | Description                               |
| ------------------- | ----------------------------------------- |
| `add config-bundle` | Add a versioned configuration bundle      |
| `cb versions`       | List version history for a bundle         |
| `cb diff`           | Diff two versions of a bundle             |
| `cb create-branch`  | Create a new branch on an existing bundle |

> Create agents with `--with-config-bundle` to auto-wire config bundle support into the generated template.

### Utilities

| Command        | Description                               |
| -------------- | ----------------------------------------- |
| `validate`     | Validate configuration files              |
| `package`      | Package agent artifacts without deploying |
| `fetch access` | Fetch access info for deployed resources  |
| `update`       | Check for and install CLI updates         |

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

- `agentcore.json` - Agent specifications, memory, credentials, evaluators, online evals
- `deployed-state.json` - Runtime state in agentcore/.cli/ (auto-managed)
- `aws-targets.json` - Deployment targets (account, region)

## Capabilities

- **Runtime** - Managed execution environment for deployed agents
- **Memory** - Semantic, summarization, and user preference strategies
- **Credentials** - Secure API key management via Secrets Manager
- **Evaluations** - LLM-as-a-Judge for on-demand and continuous agent quality monitoring

## Documentation

- [CLI Commands Reference](docs/commands.md) - Full command reference for scripting and CI/CD
- [Configuration](docs/configuration.md) - Schema reference for config files
- [Evaluations](docs/evals.md) - Evaluators, on-demand evals, and online monitoring
- [Batch Evaluation](docs/batch-evaluation.md) - Run evaluators across sessions at scale [preview]
- [Recommendations](docs/recommendations.md) - Optimize prompts and tool descriptions [preview]
- [Config Bundles](docs/config-bundles.md) - Versioned runtime configurations [preview]
- [Frameworks](docs/frameworks.md) - Supported frameworks and model providers
- [Gateway](docs/gateway.md) - Gateway setup, targets, and authentication
- [Memory](docs/memory.md) - Memory strategies and sharing
- [Local Development](docs/local-development.md) - Dev server and debugging

## Feedback & Issues

Found a bug or have a feature request? [Open an issue](https://github.com/aws/agentcore-cli/issues/new) on GitHub.

## Security

See [SECURITY](SECURITY.md) for reporting vulnerabilities and security information.

## License

This project is licensed under the Apache-2.0 License.
