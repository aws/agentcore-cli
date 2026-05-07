# Integration Tests

This directory contains integration tests that run the real CLI binary and assert on what it produces locally — no AWS
credentials, no network access, no deployed resources.

## What Integration Tests Cover

Integration tests verify that CLI commands behave correctly by checking:

- **Exit code and stdout** — the command exits `0` on success, non-zero on failure, and `--json` output has the correct
  shape
- **`agentcore/agentcore.json`** — the project config was mutated correctly after `add`, `remove`, or `create` commands
- **Scaffolded files** — `app/{agent}/pyproject.toml` contains the right framework dependencies, `app/{agent}/main.py`
  exists, `.git/` was initialized
- **Validation behavior** — the CLI rejects invalid input with the right error message before making any network call

They do **not** verify deployments, live AWS state, or agent invocation. Those belong in `e2e-tests/`.

## Prerequisites

- `npm` and `git` on PATH (some tests skip automatically if missing via `describe.skipIf`)
- `uv` on PATH (required for tests that scaffold Python agents)
- No AWS credentials needed

## Running

```bash
# Run all integration tests
npm run test:integ

# Run a specific file
npx vitest run integ-tests/add-remove-gateway.test.ts
```

## Writing Integration Tests

```typescript
import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: add and remove a gateway', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds a gateway', async () => {
    const result = await runCLI(['add', 'gateway', '--name', 'MyGateway', '--json'], project.projectPath);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const gateway = config.agentCoreGateways?.find(g => g.name === 'MyGateway');
    expect(gateway).toBeTruthy();
  });

  it('removes the gateway', async () => {
    const result = await runCLI(['remove', 'gateway', '--name', 'MyGateway', '--json'], project.projectPath);

    expect(result.exitCode).toBe(0);

    const config = await readProjectConfig(project.projectPath);
    expect(config.agentCoreGateways?.find(g => g.name === 'MyGateway')).toBeFalsy();
  });
});
```

### Key patterns

| Pattern                             | Why                                                     |
| ----------------------------------- | ------------------------------------------------------- |
| `createTestProject()`               | Fast temp project setup — no npm/uv install             |
| `runCLI([...args], projectPath)`    | Runs the real built CLI binary, not a mock              |
| `readProjectConfig(path)`           | Reads and parses `agentcore/agentcore.json`             |
| `afterAll(() => project.cleanup())` | Always delete the temp directory                        |
| `--json` flag                       | Makes stdout machine-readable for assertions            |
| Assert exit code first              | Fail fast with a useful message before asserting output |

### File naming

Name files after the feature area, not the command:

- `add-remove-gateway.test.ts` — not `add.test.ts`
- `create-frameworks.test.ts` — not `create.test.ts`
- `lifecycle-config.test.ts` — not `flags.test.ts`

### No mocking

Integration tests contain zero mocks. The CLI commands tested here make no network calls, so there is nothing to
intercept. The real binary runs against the real filesystem.

## CI/CD

Integration tests are not run automatically on every PR. They can be triggered:

1. Manually via GitHub Actions `workflow_dispatch`
2. On a schedule (if configured)
3. Before releases
