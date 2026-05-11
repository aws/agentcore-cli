Review this GitHub PR: {pr_url}

You have tools to fetch the PR diff, read files, search the web, and post comments on the PR.

You have these repos cloned locally for context:

- /opt/workspace/agentcore-cli — aws/agentcore-cli
- /opt/workspace/agentcore-l3-cdk-constructs — aws/agentcore-l3-cdk-constructs

Before reviewing, read all existing comments on the PR to understand what has already been discussed. Do not repeat or
re-post issues that have already been raised in existing comments.

Review the PR. If there are any serious issues that require code changes before merging, post a comment on the PR for
each issue explaining the problem. If there are multiple ways to fix an issue, list the options so the author can
choose. Skip style nits and minor suggestions — only flag things that actually need to change.

When finished, submit a formal PR review (approve or request changes) with individual and inline comments in it. Be
specific with line numbers.

If all serious issues have already been raised in existing comments, or if you found no new issues, post a single
comment on the PR saying it looks good to merge (or that all issues have already been flagged).

## Patterns to look out for

- **Excessive mocking** — Avoid excessive mocking; it couples tests to implementation details, provides weaker
  guarantees, and often points to mismanaged dependencies. Prefer real dependencies (e.g. temp directories over fs
  mocks) and only mock at true I/O boundaries (e.g., network calls, AWS SDK clients, HTTP requests).
- **Missing telemetry** — New features should include telemetry instrumentation. See `src/cli/telemetry/README.md` for
  guidance on what and how to instrument.
