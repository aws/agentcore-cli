<div align="center">
  <h1>AgentCore CLI</h1>
  <h2>Create, develop, and deploy AI agents to Amazon Bedrock AgentCore</h2>
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

> **Upgrading from the Bedrock AgentCore Starter Toolkit?** The old Python CLI conflicts with this package. If it is
> still installed, `npm install` will fail with an error telling you which package manager has it. Uninstall it first
> using whichever tool you originally used:
>
> ```bash
> pip uninstall bedrock-agentcore-starter-toolkit    # if installed via pip
> pipx uninstall bedrock-agentcore-starter-toolkit   # if installed via pipx
> uv tool uninstall bedrock-agentcore-starter-toolkit # if installed via uv
> ```
>
> If you need to bypass the check (for example, in CI), set `AGENTCORE_SKIP_CONFLICT_CHECK=1` before installing.

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

| Provider       | API Key Required          | Default Model                 |
| -------------- | ------------------------- | ----------------------------- |
| Amazon Bedrock | No (uses AWS credentials) | claude-sonnet-4-5-20250929-v1 |
| Anthropic      | Yes                       | claude-sonnet-4-5-20250929    |
| Google Gemini  | Yes                       | gemini-2.5-flash              |
| OpenAI         | Yes                       | gpt-4o                        |

## Commands

### Project Lifecycle

| Command  | Description                    |
| -------- | ------------------------------ |
| `create` | Create a new AgentCore project |
| `dev`    | Start local development server |
| `deploy` | Deploy infrastructure to AWS   |
| `invoke` | Invoke deployed agents         |

### Resource Management

| Command  | Description                                       |
| -------- | ------------------------------------------------- |
| `add`    | Add agents, memory, identity, evaluators, targets |
| `remove` | Remove resources from project                     |

> **Note**: Run `agentcore deploy` after `add` or `remove` to update resources in AWS.

### Evaluations

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `add evaluator`      | Add a custom LLM-as-a-Judge evaluator         |
| `add online-eval`    | Add continuous evaluation for live traffic    |
| `run evals`          | Run on-demand evaluation against agent traces |
| `evals history`      | View past eval run results                    |
| `pause online-eval`  | Pause a deployed online eval config           |
| `resume online-eval` | Resume a paused online eval config            |

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

- `agentcore.json` - Agent specifications, memory, identity, evaluators, online evals
- `deployed-state.json` - Runtime state in agentcore/.cli/ (auto-managed)
- `aws-targets.json` - Deployment targets (account, region)

## Capabilities

- **Runtime** - Managed execution environment for deployed agents
- **Memory** - Semantic, summarization, and user preference strategies
- **Identity** - Secure API key management via Secrets Manager
- **Evaluations** - LLM-as-a-Judge for on-demand and continuous agent quality monitoring

## Documentation

- [CLI Commands Reference](docs/commands.md) - Full command reference for scripting and CI/CD
- [Configuration](docs/configuration.md) - Schema reference for config files
- [Evaluations](docs/evals.md) - Evaluators, on-demand evals, and online monitoring
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
