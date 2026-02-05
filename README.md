# @aws/agentcore-cli

CLI tool for Amazon Bedrock AgentCore. Create, develop, and deploy agentic applications on AWS.

## Prerequisites

- **Node.js** 18.x or later
- **AWS CLI** configured with credentials
- **uv** for Python agents ([install](https://docs.astral.sh/uv/getting-started/installation/))
- **AWS CDK** bootstrapped: `npx cdk bootstrap aws://ACCOUNT_ID/REGION`

## Installation

```bash
npm install -g @aws/agentcore-cli
```

## Quick Start

```bash
# Create a new project (wizard guides you through agent setup)
agentcore-cli create
cd my-project

# Test locally
agentcore-cli dev
# In another terminal:
agentcore-cli invoke

# Deploy to AWS
agentcore-cli deploy

# Invoke deployed agent
agentcore-cli invoke --stream
```

## Supported Frameworks

| Framework           | Notes                         |
| ------------------- | ----------------------------- |
| Strands             | AWS-native, streaming support |
| LangChain/LangGraph | Graph-based workflows         |
| AutoGen             | Multi-agent conversations     |
| CrewAI              | Role-based agent teams        |
| Google ADK          | Gemini only                   |
| OpenAI Agents       | OpenAI only                   |

## Supported Model Providers

| Provider       | API Key Required          | Default Model              |
| -------------- | ------------------------- | -------------------------- |
| Amazon Bedrock | No (uses AWS credentials) | Claude Sonnet 4.5          |
| Anthropic      | Yes                       | claude-sonnet-4-5-20250929 |
| Google Gemini  | Yes                       | gemini-2.0-flash           |
| OpenAI         | Yes                       | gpt-4o                     |

## Commands

### Project Lifecycle

| Command    | Description                    |
| ---------- | ------------------------------ |
| `create`   | Create a new AgentCore project |
| `validate` | Validate configuration files   |
| `plan`     | Preview infrastructure changes |
| `deploy`   | Deploy infrastructure to AWS   |
| `status`   | Check deployment status        |
| `destroy`  | Tear down deployed resources   |

### Resource Management

| Command  | Description                             |
| -------- | --------------------------------------- |
| `add`    | Add agents, memory, identity, MCP tools |
| `remove` | Remove resources from project           |
| `attach` | Connect resources to agents             |

### Development

| Command   | Description                               |
| --------- | ----------------------------------------- |
| `dev`     | Start local development server            |
| `invoke`  | Invoke local or deployed agents           |
| `package` | Package agent artifacts without deploying |

### Utilities

| Command   | Description                   |
| --------- | ----------------------------- |
| `outline` | Display project resource tree |
| `edit`    | Interactive schema editor     |
| `update`  | Check for CLI updates         |

## Project Structure

```
my-project/
├── agentcore/
│   ├── agentcore.json      # Agent specifications
│   ├── aws-targets.json    # Deployment targets
│   ├── mcp.json            # MCP tool config
│   └── cdk/                # CDK infrastructure
├── app/                    # Agent code
└── .env.local              # API keys (gitignored)
```

## Configuration

Projects use JSON schema files in the `agentcore/` directory:

- `agentcore.json` - Agent specifications, memory, identity, remote tools
- `aws-targets.json` - Deployment targets (account, region)
- `mcp.json` - MCP tool definitions
- `deployed-state.json` - Runtime state (auto-managed)

## Primitives

- **Memory** - Semantic, summarization, and user preference strategies
- **Identity** - Secure API key management via Secrets Manager
- **MCP Tools** - Extend agent capabilities with custom tools
- **MCP Runtime Tools** - Direct agent-to-tool connections
- **Agent-to-Agent** - Agents invoking other agents as tools

## Invoking Agents

```bash
# Interactive mode
agentcore-cli invoke

# With prompt and streaming
agentcore-cli invoke "What can you do?" --stream

# Session management
agentcore-cli invoke --session-id <id>   # Continue conversation
agentcore-cli invoke --new-session       # Start fresh
```

## Documentation

- [CLI Commands Reference](docs/commands.md) - Full command reference for scripting and CI/CD
- [Configuration](docs/configuration.md) - Schema reference for config files
- [MCP Tools](docs/mcp-tools.md) - MCP runtime tools
- [Memory](docs/memory.md) - Memory strategies and sharing
- [Local Development](docs/local-development.md) - Dev server and debugging

## Library Usage

The CLI exports utilities for programmatic use:

```typescript
import { type AgentEnvSpec, ConfigIO } from '@aws/agentcore-cli';

const configIO = new ConfigIO({ baseDir: './agentcore' });
const spec = await configIO.readProjectSpec();
```

## Related Package

- `@aws/agentcore-l3-cdk-constructs` - CDK constructs for standalone infrastructure-as-code usage

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.
