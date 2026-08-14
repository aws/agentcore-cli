# Harness Resources

Container and scripts for AI-powered automation via
[AgentCore Harness](https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore.html).

## Structure

```
harness/
├── Dockerfile            # Container image for the harness runtime
├── harness_review.py     # Invokes the harness to review PRs (SigV4 + event stream)
└── prompts/
    ├── system.md         # System prompt (workspace context)
    └── review.md         # PR review task prompt
```

## Current: PR Reviewer

Reviews pull requests on open/reopen via `.github/workflows/pr-ai-review.yml`.

### Authentication

The Dockerfile takes one build arg:

- **`CLONE_TOKEN`** — baked into git config for cloning private repos

The workflow-side review script uses its short-lived **`GITHUB_TOKEN`** to read existing PR discussion and submit the
Harness result. The token is never sent to the Harness runtime or persisted in the Harness image.

### Building the container

```bash
finch build \
  --build-arg CLONE_TOKEN=<pat-for-cloning> \
  -t pr-reviewer .github/harness/
```

## Future: Tester

This directory will also house a harness-based test runner.
