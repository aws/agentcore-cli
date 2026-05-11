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

## Test Organization

```
e2e-tests/
├── e2e-helper.ts           # Shared utilities and createE2ESuite() factory
├── strands-bedrock.test.ts
├── langgraph-openai.test.ts
└── ...
```

See [e2e-tests/README.md](../../e2e-tests/README.md) for full details.
