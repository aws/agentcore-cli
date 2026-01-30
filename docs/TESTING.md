# Testing Guide

## Quick Start

```bash
npm test           # Run all tests
npm run test:watch # Run tests in watch mode
```

## Test Organization

### Unit Tests

Unit tests are co-located with source files in `__tests__/` directories:

```
src/cli/commands/add/
├── action.ts
├── command.ts
└── __tests__/
    └── add.test.ts
```

### Integration Tests

Integration tests live in `integ-tests/`:

```
integ-tests/
├── create-no-agent.test.ts
├── create-with-agent.test.ts
├── deploy.test.ts
└── ...
```

See [integ-tests/README.md](../integ-tests/README.md) for integration test details.

## Writing Tests

### Imports

Use vitest for all test utilities:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

### Assertions

Use `expect` assertions:

```typescript
// Equality
expect(result).toBe('expected');
expect(obj).toEqual({ key: 'value' });

// Truthiness
expect(value).toBeTruthy();
expect(value).toBeFalsy();

// Errors
expect(() => fn()).toThrow();
expect(() => fn()).toThrow('message');
```

### Mocking

Use `vi` for mocks:

```typescript
// Mock functions
const mockFn = vi.fn();
mockFn.mockReturnValue('value');
mockFn.mockResolvedValue('async value');

// Spies
vi.spyOn(module, 'method');

// Module mocks
vi.mock('./module');
```

## Test Utilities

### CLI Runner

`src/test-utils/cli-runner.ts` runs CLI commands in tests:

```typescript
import { runCLI } from '../src/test-utils/cli-runner';

const result = await runCLI(['create', '--name', 'test'], tempDir);
expect(result.exitCode).toBe(0);
```

## Configuration

Test configuration is in `vitest.config.ts`:

- Test timeout: 15 seconds
- Hook timeout: 60 seconds
- Test patterns: `src/**/*.test.ts`, `integ-tests/**/*.test.ts`

## Integration Tests

Integration tests require:

- AWS credentials configured
- IAM permissions for CloudFormation operations
- Dedicated test AWS account (recommended)

Run integration tests:

```bash
npm run test:integ
```
