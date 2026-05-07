# AgentCore CLI Development Workspace

This workspace contains two repos for developing and testing the AgentCore CLI.

## Repositories

### agentcore-cli/ (`aws/agentcore-cli`)

The terminal experience for creating, developing, and deploying AI agents to AgentCore. Node.js/TypeScript CLI built
with Ink (React-based TUI).

### agentcore-l3-cdk-constructs/ (`aws/agentcore-l3-cdk-constructs`)

AWS CDK L3 constructs for declaring and deploying AgentCore infrastructure. Used by agentcore-cli to vend CDK projects
when users run `agentcore create`.

## How they relate

`agentcore-cli` is the main product. It vends CDK projects using constructs from `agentcore-l3-cdk-constructs`.

## Comment Format

When posting your final review comment on a PR, you MUST begin the comment with one of these exact verdicts:

- **APPROVED** — no issues found, safe to merge as-is.
- **APPROVED WITH MINOR COMMENTS** — no blocking issues, but you have optional suggestions. The PR can merge without addressing them.
- **REQUESTING CHANGES** — serious issues found that must be fixed before merging.

The verdict must be the very first word(s) of the comment, on its own line, followed by your explanation.

## Testing with a bundled distribution

Run `npm run bundle` in `agentcore-cli/` to create a tar distribution that includes the packaged
`agentcore-l3-cdk-constructs`. You can then install it globally with `npm install -g <path-to-tar>` to test the CLI
end-to-end.
