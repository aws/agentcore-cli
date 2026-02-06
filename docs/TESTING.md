# Testing Guide

## Quick Start

```bash
npm test           # Run unit tests
npm run test:watch # Run tests in watch mode
npm run test:integ # Run integration tests
npm run test:all   # Run all tests (unit + integ)
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

## Snapshot Tests

The `src/assets/` directory contains template files vended to users when they create projects. Snapshot tests ensure
these templates don't change unexpectedly.

### Running Snapshot Tests

Snapshot tests run as part of unit tests:

```bash
npm test           # Runs all unit tests including snapshots
npm run test:unit  # Same as above
```

### Updating Snapshots

When you intentionally modify asset files (templates, configs, etc.), update snapshots:

```bash
npm run test:update-snapshots
```

Review the changes in `src/assets/__tests__/__snapshots__/` before committing.

### What's Tested

- File structure of `src/assets/`
- Contents of all template files (CDK, Python frameworks, MCP, static assets)
- Any file addition or removal

## Configuration

Test configuration is in `vitest.config.ts` using Vitest projects:

- **unit** project: `src/**/*.test.ts` (includes snapshot tests)
- **integ** project: `integ-tests/**/*.test.ts`
- Test timeout: 120 seconds
- Hook timeout: 120 seconds

## Integration Tests

Integration tests require:

- AWS credentials configured
- IAM permissions for CloudFormation operations
- Dedicated test AWS account (recommended)

Run integration tests:

```bash
npm run test:integ
```
