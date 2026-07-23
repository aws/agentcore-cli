# E2E Tests

E2E tests verify the full user journey across the AWS boundary — deploy, invoke, status, logs, traces, and control plane
API calls.

## Prerequisites

- AWS credentials configured (`aws sts get-caller-identity` must succeed)
- Local build (`npm run build`)

See [e2e-tests/README.md](../../e2e-tests/README.md) for full prerequisite details.

## Running

```bash
npm run test:e2e      # Run e2e tests
```

## Running a Specific Test on a PR

Use the **E2E Tests** workflow's **Run workflow** form:

1. Set `pr_number` to the PR whose head commit should be tested.
2. Set `test_selector` to a test file, such as `e2e-tests/import-gateway.test.ts`.
3. To run one exact test, append its source line, such as `e2e-tests/import-gateway.test.ts:120`.
4. Optionally set `test_name_pattern` to a Vitest test-name regular expression.

When `test_selector` is set, the workflow runs only that selection instead of the baseline and changed E2E files. A
maintainer can use this flow for an external PR after reviewing its code.

## Test Organization

```
e2e-tests/
├── e2e-helper.ts           # Shared utilities and createE2ESuite() factory
├── strands-bedrock.test.ts
├── langgraph-openai.test.ts
└── ...
```

See [e2e-tests/README.md](../../e2e-tests/README.md) for full details.
