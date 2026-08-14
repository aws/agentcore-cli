# Harness Resources

Container and scripts for AI-powered automation via
[AgentCore Harness](https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore.html).

## Structure

```
harness/
├── Dockerfile            # Container image for the harness runtime
└── prompts/
    ├── system.md         # System prompt (workspace context)
    └── review.md         # PR review task prompt
```

## Current: PR Reviewer

Reviews pull requests on open/reopen via `.github/workflows/pr-ai-review.yml`.

### Authentication

The Dockerfile takes one build arg:

- **`CLONE_TOKEN`** — baked into git config for cloning private repos

The shared `agentcore-devx-devtools` workflow reads PR discussion and publishes the Harness result with the workflow
run's short-lived `GITHUB_TOKEN`. The token is never sent to the Harness runtime or persisted in this image.

### Building the container

```bash
finch build \
  --build-arg CLONE_TOKEN=<pat-for-cloning> \
  -t pr-reviewer .github/harness/
```

## Future: Tester

This directory will also house a harness-based test runner.
