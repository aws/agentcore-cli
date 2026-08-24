# AgentCore CLI PR Reviewer

AgentCore CLI project for the automated pull-request reviewer used by `.github/workflows/pr-automation.yml`.

This project was generated with AgentCore CLI 0.27.0, using the legacy `.github/harness/Dockerfile` before the harness
assets were moved here:

```bash
agentcore create \
  --name PRReviewer \
  --project-name AgentCoreCliReviewer \
  --model-provider bedrock \
  --model-id us.anthropic.claude-opus-4-7 \
  --container .github/harness/Dockerfile \
  --no-harness-memory
```

## Structure

```text
AgentCoreCliReviewer/
├── agentcore/                       # AgentCore and CDK deployment configuration
└── app/PRReviewer/
    ├── Dockerfile                   # Review workspace image
    ├── harness.json                 # Harness model and runtime configuration
    ├── harness_review.py            # GitHub Actions invocation client
    ├── prompts/review.md            # Pull-request review task
    └── system-prompt.md             # AgentCore CLI workspace context
```

## Deploy

The default target is account `631957124172` in `us-east-1`.

```bash
AWS_PROFILE=deploy agentcore validate
AWS_PROFILE=deploy agentcore deploy --yes
```

The GitHub Actions invocation role is `arn:aws:iam::631957124172:role/GitHubActions-AgentCoreCliHarnessReview`. After
the authenticated image described below is deployed, update these AWS Secrets Manager values to cut the workflow over:

- `aws/agentcore-cli/HARNESS_ARN`: the Harness ARN returned by `agentcore status`
- `aws/agentcore-cli/HARNESS_AWS_ROLE_ARN`: the GitHub Actions invocation role ARN above

The Dockerfile expects a `CLONE_TOKEN` build argument. AgentCore CLI's Harness Dockerfile build does not currently
expose custom build arguments, so a production deployment must use a prebuilt private ECR image with that argument or
migrate clone authentication to a runtime-supported secret mechanism.

The shared `agentcore-devx-devtools` workflow mints a short-lived token from the existing GitHub App to read PR
discussion and publish the Harness result as `agentcore-devx-automation[bot]`. The token is never sent to the Harness
runtime or persisted in this image.
