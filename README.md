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
- **AWS CLI** configured with credentials
- **uv** for Python agents ([install](https://docs.astral.sh/uv/getting-started/installation/))
- **AWS CDK** bootstrapped: `npx cdk bootstrap aws://ACCOUNT_ID/REGION`

## Installation

```bash
npm install -g @aws/agentcore-cli
```

> **Public Preview**: If you previously used the
> [Bedrock AgentCore Starter Toolkit](https://github.com/aws/bedrock-agentcore-starter-toolkit), uninstall it before
> using this CLI:
>
> ```bash
> pip uninstall bedrock-agentcore-starter-toolkit
> ```

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

# In another terminal:
agentcore invoke

# Deploy to AWS
agentcore deploy

# Invoke deployed agent with streaming
agentcore invoke --stream
```

## Supported Frameworks

| Framework           | Notes                         |
| ------------------- | ----------------------------- |
| Strands             | AWS-native, streaming support |
| LangChain/LangGraph | Graph-based workflows         |
| AutoGen             | Multi-agent conversations     |
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

| Command    | Description                    |
| ---------- | ------------------------------ |
| `create`   | Create a new AgentCore project |
| `validate` | Validate configuration files   |
| `deploy`   | Deploy infrastructure to AWS   |
| `status`   | Check deployment status        |
| `destroy`  | Tear down deployed resources   |

### Resource Management

| Command  | Description                           |
| -------- | ------------------------------------- |
| `add`    | Add agents, memory, identity, targets |
| `remove` | Remove resources from project         |

### Development

| Command   | Description                               |
| --------- | ----------------------------------------- |
| `dev`     | Start local development server            |
| `invoke`  | Invoke local or deployed agents           |
| `package` | Package agent artifacts without deploying |

### Utilities

| Command  | Description           |
| -------- | --------------------- |
| `update` | Check for CLI updates |

## Project Structure

```
my-project/
├── agentcore/
│   ├── agentcore.json      # Agent specifications
│   ├── aws-targets.json    # Deployment targets
│   └── cdk/                # CDK infrastructure
├── app/                    # Agent code
└── .env.local              # API keys (gitignored)
```

## Configuration

Projects use JSON schema files in the `agentcore/` directory:

- `agentcore.json` - Agent specifications, memory, identity, remote tools
- `aws-targets.json` - Deployment targets (account, region)
- `deployed-state.json` - Runtime state (auto-managed)

## Primitives

- **Memory** - Semantic, summarization, and user preference strategies
- **Identity** - Secure API key management via Secrets Manager

## Invoking Agents

```bash
# Interactive mode
agentcore invoke

# With prompt and streaming
agentcore invoke "What can you do?" --stream

# Session management
agentcore invoke --session-id <id>   # Continue conversation
agentcore invoke --new-session       # Start fresh
```

## Documentation

- [CLI Commands Reference](docs/commands.md) - Full command reference for scripting and CI/CD
- [Configuration](docs/configuration.md) - Schema reference for config files
- [Memory](docs/memory.md) - Memory strategies and sharing
- [Local Development](docs/local-development.md) - Dev server and debugging

## Related Package

- `@aws/agentcore-l3-cdk-constructs` - CDK constructs for standalone infrastructure-as-code usage

## Roadmap

- **Gateway Support** - Integration with
  [AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) to connect APIs,
  Lambda functions, and services as MCP-compatible tools
- **Observability** - Built-in tracing, debugging, and monitoring via
  [AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html) with
  CloudWatch integration
- **VPC Hosting** - Deploy agents within your VPC for private network access

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.
