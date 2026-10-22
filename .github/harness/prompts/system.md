# AgentCore CLI Development Workspace

This workspace contains two repos for developing and testing the AgentCore CLI.

## Repositories

### agentcore-cli/ (`aws/agentcore-cli`)

The terminal experience for creating, developing, and deploying AI agents to AgentCore. Node.js/TypeScript CLI built
with Ink (React-based TUI).

> **Branches:** The v1 release line (`refactor`, later `v1.x`) is the default branch and has a different
> source layout from v0 (`main`, later `v0.x`): `src/handlers/`, `src/core/` rather than `src/cli/`,
> `src/lib/`. Always analyze a PR against its own base branch.

### agentcore-l3-cdk-constructs/ (`aws/agentcore-l3-cdk-constructs`)

AWS CDK L3 constructs for declaring and deploying AgentCore infrastructure. Used by agentcore-cli to vend CDK projects
when users run `agentcore create`.

## How they relate

`agentcore-cli` is the main product. It vends CDK projects using constructs from `agentcore-l3-cdk-constructs`.
