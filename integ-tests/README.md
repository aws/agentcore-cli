# Integration Tests

This directory contains real AWS integration tests that actually deploy resources.

## Prerequisites

- AWS credentials configured
- Sufficient IAM permissions to create/delete CloudFormation stacks
- A dedicated test AWS account (recommended)

## Running Integration Tests

```bash
# Run all integration tests
npm run test:integ

# Run a specific test
npx vitest run integ-tests/deploy.test.ts --testTimeout=300000
```

## Test Naming Convention

All integration test files should be prefixed with `integ.`:

- `integ.deploy.ts` - Tests actual deployment
- `integ.invoke.ts` - Tests invoking deployed agents
- `integ.destroy.ts` - Tests stack destruction
- `integ.e2e.ts` - Full end-to-end lifecycle test

## CI/CD

Integration tests are NOT run automatically on every PR. They can be triggered:

1. Manually via GitHub Actions workflow_dispatch
2. On a schedule (if configured)
3. Before releases

## Writing Integration Tests

```typescript
import { runCLI } from '../src/test-utils/cli-runner';
import { afterAll, describe, expect, it } from 'vitest';

describe('integ: deploy', () => {
  // Use unique stack names to avoid conflicts
  const stackName = `test-${Date.now()}`;

  afterAll(async () => {
    // ALWAYS clean up - destroy the stack
    await runCLI(['destroy', '--target', stackName, '--force'], projectDir);
  });

  it('deploys successfully', async () => {
    // Test implementation
  });
});
```

## Important Notes

- Integration tests create real AWS resources and may incur costs
- Always include cleanup in `after()` hooks
- Use unique names to avoid conflicts with parallel runs
- Set appropriate timeouts (5-15 minutes for deploy operations)
