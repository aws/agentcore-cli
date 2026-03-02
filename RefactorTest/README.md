# AgentCore Project

This project was created with the [AgentCore CLI](https://github.com/aws/agentcore-cli).

## Project Structure

```
.
my-project/
├── agentcore/
│   ├── .env.local          # API keys (gitignored)
│   ├── agentcore.json      # Resource specifications
│   ├── aws-targets.json    # Deployment targets
│   └── cdk/                # CDK infrastructure
├── app/                    # Application code
```

## Getting Started

### Prerequisites

- **Node.js** 20.x or later
- **uv** for Python agents ([install](https://docs.astral.sh/uv/getting-started/installation/))

### Development

Run your agent locally:

```bash
agentcore dev
```

### Deployment

Deploy to AWS:

```bash
agentcore deploy
```

Or use CDK directly:

```bash
cd agentcore/cdk
npx cdk deploy
```

## Configuration

Edit the JSON files in `agentcore/` to configure your agents, memory, and credentials. See `agentcore/.llm-context/` for
type definitions and validation constraints.

The project uses a **flat resource model** where agents, memories, and credentials are top-level arrays in
`agentcore.json`.

## Commands

| Command              | Description                                     |
| -------------------- | ----------------------------------------------- |
| `agentcore create`   | Create a new AgentCore project                  |
| `agentcore add`      | Add resources (agent, memory, identity, target) |
| `agentcore remove`   | Remove resources                                |
| `agentcore dev`      | Run agent locally                               |
| `agentcore deploy`   | Deploy to AWS                                   |
| `agentcore status`   | Show deployment status                          |
| `agentcore invoke`   | Invoke agent (local or deployed)                |
| `agentcore package`  | Package agent artifacts                         |
| `agentcore validate` | Validate configuration                          |
| `agentcore update`   | Check for CLI updates                           |

### Agent Types

- **Template agents**: Created from framework templates (Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents)
- **BYO agents**: Bring your own code with `agentcore add agent --type byo`

## Documentation

- [AgentCore CLI Documentation](https://github.com/aws/agentcore-cli)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)
