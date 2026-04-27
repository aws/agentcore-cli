# AgentCore CLI Development Workspace

This workspace contains two repos for developing and testing the AgentCore CLI.

## Repositories

### agentcore-cli/ (`aws/agentcore-cli`)

The terminal experience for creating, developing, and deploying AI agents to AgentCore. Node.js/TypeScript CLI built with Ink (React-based TUI).

### agentcore-l3-cdk-constructs/ (`aws/agentcore-l3-cdk-constructs`)

AWS CDK L3 constructs for declaring and deploying AgentCore infrastructure. Used by agentcore-cli to vend CDK projects when users run `agentcore create`.

## How they relate

`agentcore-cli` is the main product. It vends CDK projects using constructs from `agentcore-l3-cdk-constructs`.

## Testing with a bundled distribution

Run `npm run bundle` in `agentcore-cli/` to create a tar distribution that includes the packaged `agentcore-l3-cdk-constructs`. You can then install it globally with `npm install -g <path-to-tar>` to test the CLI end-to-end.
