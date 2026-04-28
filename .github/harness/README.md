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

### Dual-token setup

The Dockerfile takes two build args:

- **`CLONE_TOKEN`** — baked into git config for cloning private repos
- **`GITHUB_TOKEN`** — baked into `gh` CLI auth for posting PR comments

### Building the container

```bash
finch build \
  --build-arg CLONE_TOKEN=<pat-for-cloning> \
  --build-arg GITHUB_TOKEN=<pat-for-gh-api> \
  -t pr-reviewer .github/harness/
```

## Future: Tester

This directory will also house a harness-based test runner.
