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

## Submitting Your Review

When you have finished reviewing, submit a formal GitHub PR review using the `gh` CLI — do NOT post a plain comment.

Use one of these commands depending on your verdict:

```bash
# No issues — approve the PR
gh pr review <pr-number> --approve --body "<your summary>"

# Serious issues that must be fixed before merging
gh pr review <pr-number> --request-changes --body "<your summary>"

# No blocking issues, but you have optional suggestions
gh pr review <pr-number> --comment --body "<your summary>"
```

Rules:
- Always use `gh pr review`, never `gh pr comment`.
- Use `--approve` when the PR is safe to merge as-is.
- Use `--request-changes` when there are issues that must be fixed before merging.
- Use `--comment` when you have minor, non-blocking suggestions the author can optionally address.
- The body should summarize your findings. If you flagged individual lines earlier with inline comments, reference them in the summary.

## Testing with a bundled distribution

Run `npm run bundle` in `agentcore-cli/` to create a tar distribution that includes the packaged
`agentcore-l3-cdk-constructs`. You can then install it globally with `npm install -g <path-to-tar>` to test the CLI
end-to-end.
