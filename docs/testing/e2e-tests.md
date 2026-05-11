# E2E Tests

E2E tests verify the full user journey across the AWS boundary — deploy, invoke, status, logs, traces, and control
plane API calls.

## Running

```bash
npm run test:all      # Run all tests (unit + integ)
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
