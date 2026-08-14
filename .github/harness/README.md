# Harness Resources

Container and repository-specific prompts for AI-powered automation via
[AgentCore Harness](https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore.html).

## Structure

```
harness/
|-- Dockerfile            # Container image for the harness runtime
`-- prompts/
    |-- system.md         # System prompt (workspace context)
    `-- review.md         # PR review task prompt
```

## Current: PR Reviewer

Reviews pull requests on open/reopen via `.github/workflows/pr-automation.yml`.
The reusable workflow and invocation action live in
`aws/agentcore-devx-devtools`.

### Authentication

The Dockerfile takes one build arg:

- **`CLONE_TOKEN`** - baked into git config for cloning private repos

The shared workflow mints a short-lived token from the existing GitHub App to
read PR discussion and publish the Harness result as
`agentcore-devx-automation[bot]`. The token is never sent to the Harness runtime
or persisted in this image.

### Building the container

```bash
finch build \
  --build-arg CLONE_TOKEN=<pat-for-cloning> \
  -t pr-reviewer .github/harness/
```
