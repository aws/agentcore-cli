# E2E Tests

This directory contains end-to-end tests that verify the full user journey across the AWS boundary. They create, deploy,
invoke, and destroy real AWS resources.

## What E2E Tests Cover

E2E tests verify behaviors that require AWS to confirm they happened:

- **Deployment** — `agentcore deploy` creates a real CloudFormation stack
- **`deployed-state.json`** — after deploy, `agentcore/.cli/deployed-state.json` contains the correct ARNs and IDs for
  each deployed resource
- **Live AWS state** — `agentcore status` returns a real resource ARN and `deploymentState: 'deployed'`
- **Live agent behavior** — `agentcore invoke` succeeds against a running agent
- **Observability** — `agentcore logs` returns real CloudWatch entries, `agentcore traces list` returns real trace data
- **Direct control plane API calls** — `pause`, `resume`, and `promote` on AB tests return live execution state from AWS

They do **not** verify config file mutations or CLI input validation. Those belong in `integ-tests/`.

## Prerequisites

- AWS credentials configured (`aws sts get-caller-identity` must succeed)
- `npm`, `git`, and `uv` on PATH
- Sufficient IAM permissions to create/delete CloudFormation stacks
- A dedicated test AWS account (recommended to avoid cost surprises)
- Model-specific API keys set as env vars for non-Bedrock providers (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GOOGLE_API_KEY`)

## Running

```bash
# Run all e2e tests (requires AWS credentials)
npm run test:e2e

# Run a specific file
npx vitest run e2e-tests/strands-bedrock.test.ts
```

E2E tests are not run automatically on every PR. They run on a schedule and before releases.

## Writing E2E Tests

Most framework/model combination tests are a single call to `createE2ESuite()`:

```typescript
import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({
  framework: 'Strands',
  modelProvider: 'Bedrock',
});
```

`createE2ESuite()` generates the full lifecycle suite: `create → deploy → invoke → status → logs → traces → destroy`.

For feature-specific lifecycle tests (AB tests, evals, config bundles), write the suite directly using helpers from
`e2e-helper.ts`:

```typescript
import { baseCanRun, hasAws, runAgentCoreCLI, teardownE2EProject, writeAwsTargets } from './e2e-helper.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: my feature lifecycle', () => {
  let projectPath: string;
  const agentName = `E2eMyFeat${String(Date.now()).slice(-8)}`;

  beforeAll(async () => {
    if (!canRun) return;
    // create project, write AWS targets
    await writeAwsTargets(projectPath);
  }, 300000);

  // Always destroy AWS resources — never skip this
  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
  }, 600000);

  it.skipIf(!canRun)(
    'deploys to AWS successfully',
    async () => {
      const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);
    },
    600000
  );
});
```

### Key patterns

| Pattern                                   | Why                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `describe.sequential`                     | Tests depend on each other — deploy must succeed before invoke        |
| `it.skipIf(!canRun)`                      | Gracefully skips when credentials or prerequisites are missing        |
| `afterAll(() => teardownE2EProject(...))` | Always destroy AWS resources to avoid cost and leakage                |
| `retry(fn, 3, 15000)`                     | AWS operations are eventually consistent — retries handle cold starts |
| `hasAwsCredentials()`                     | Gate the entire suite — skip all if no credentials                    |
| Long timeouts (600000ms)                  | CloudFormation deploys take minutes, not seconds                      |

### File naming

Framework/model combination tests: `{framework}-{model}.test.ts`

- `strands-bedrock.test.ts`
- `langgraph-openai.test.ts`

Feature lifecycle tests: describe what the test exercises end-to-end

- `ab-test-target-based.test.ts`
- `dev-lifecycle.test.ts`
- `evals-lifecycle.test.ts`

## Important Notes

- E2E tests create real AWS resources and **will incur costs**
- Always include `teardownE2EProject()` in `afterAll` — never skip cleanup
- Use unique agent names (timestamp suffix) to avoid conflicts with parallel runs
- Stale credential providers older than 30 minutes are cleaned up automatically in `beforeAll` via
  `cleanupStaleCredentialProviders()`
