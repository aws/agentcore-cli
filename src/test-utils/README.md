# Test Utilities

Shared utilities for CLI tests.

## Usage

```typescript
import { exists, runCLI } from '../../../test-utils/index.js';
```

## API

### `runCLI(args: string[], cwd: string): Promise<RunResult>`

Runs the AgentCore CLI with the given arguments in the specified directory.

**Parameters:**

- `args` - Array of CLI arguments (e.g., `['create', '--name', 'MyProject']`)
- `cwd` - Working directory to run the command in

**Returns:**

```typescript
interface RunResult {
  stdout: string; // Standard output (ANSI codes stripped)
  stderr: string; // Standard error
  exitCode: number; // Process exit code
}
```

**Example:**

```typescript
const result = await runCLI(['create', '--name', 'Test', '--no-agent', '--json'], testDir);
if (result.exitCode === 0) {
  const json = JSON.parse(result.stdout);
  console.log(json.projectPath);
}
```

### `exists(path: string): Promise<boolean>`

Checks if a file or directory exists.

**Parameters:**

- `path` - Path to check

**Returns:** `true` if path exists, `false` otherwise

**Example:**

```typescript
if (await exists(join(projectDir, 'agentcore/agentcore.json'))) {
  // File exists
}
```

## Writing Tests

Tests are colocated with source code in `src/cli/commands/**/*.test.ts`.

### Test Structure

```typescript
import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('my command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project for tests
    const result = await runCLI(['create', '--name', 'TestProj', '--no-agent'], testDir);
    projectDir = join(testDir, 'TestProj');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('does something', async () => {
    const result = await runCLI(['my-command', '--json'], projectDir);
    assert.strictEqual(result.exitCode, 0);
  });
});
```

### Running Tests

```bash
# Run all unit tests
npm test

# Run specific test file
bun test src/cli/commands/add/add-agent.test.ts

# Run with longer timeout
bun test --timeout 120000 src/cli/commands/
```

## Test Locations

| Command        | Test File                                  |
| -------------- | ------------------------------------------ |
| `create`       | `src/cli/commands/create/create.test.ts`   |
| `add agent`    | `src/cli/commands/add/add-agent.test.ts`   |
| `add gateway`  | `src/cli/commands/add/add-gateway.test.ts` |
| `remove agent` | `src/cli/commands/remove/remove.test.ts`   |
| `deploy`       | `src/cli/commands/deploy/deploy.test.ts`   |
| `invoke`       | `src/cli/commands/invoke/invoke.test.ts`   |
| `plan`         | `src/cli/commands/plan/plan.test.ts`       |
| `destroy`      | `src/cli/commands/destroy/destroy.test.ts` |
