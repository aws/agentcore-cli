# AgentCore Project

This project was created with the [AgentCore CLI](https://github.com/aws/agentcore-cli).

## Project Structure

```
.
├── agentcore/              # AgentCore configuration directory
│   ├── agentcore.json      # Main workspace config
│   ├── mcp.json            # MCP gateways and tools
│   ├── mcp-defs.json       # Tool definitions
│   └── cdk/                # AWS CDK project for deployment
├── app/                    # Application code (if agents were created)
└── AGENTS.md               # AI coding assistant context
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- [AgentCore CLI](https://github.com/awslabs/amazon-bedrock-agentcore) installed globally

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

Edit the JSON files in `agentcore/` to configure your agents, memory, identity, and tools. See `agentcore/.llm-context/`
for type definitions and validation constraints.

## Commands

| Command              | Description                         |
| -------------------- | ----------------------------------- |
| `agentcore dev`      | Run agent locally                   |
| `agentcore deploy`   | Deploy to AWS                       |
| `agentcore status`   | Show deployment status              |
| `agentcore invoke`   | Invoke deployed agent               |
| `agentcore add`      | Add agents, memory, identity, tools |
| `agentcore remove`   | Remove resources                    |
| `agentcore validate` | Validate configuration              |

## Documentation

- [AgentCore CLI Documentation](https://github.com/aws/agentcore-cli)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)
