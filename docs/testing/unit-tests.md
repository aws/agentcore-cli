# Unit Tests

Unit tests are co-located with source files in `__tests__/` directories:

```
src/cli/commands/add/
├── action.ts
├── command.ts
└── __tests__/
    └── add.test.ts
```

## Running

```bash
npm test              # Run unit tests
npm run test:watch    # Run tests in watch mode
npm run test:unit     # Same as npm test
```

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

## CDK Schema Compatibility Test

The vended CDK template (`src/assets/cdk/package.json`) exact-pins `aws-cdk-lib`. This pin controls the cloud-assembly
schema version that user projects _write_ at synth time; the CLI's bundled readers (`@aws-cdk/toolkit-lib`,
`@aws-cdk/cdk-assets-lib`) can only _read_ schemas up to their own version. Readers accept older schemas but hard-fail
on newer ones, so an unpinned template broke every fresh project's deploy with `AssemblyVersionMismatch` when upstream
`aws-cdk-lib` bumped the schema (ticket V2240408418).

`src/assets/__tests__/cdk-schema-compat.test.ts` enforces the coupling:

- The template pin is exact and matches both the root `devDependencies['aws-cdk-lib']` (the lockstep anchor) and the
  installed copy in `node_modules`.
- Each bundled reader's max supported schema version is >= the schema version the pinned `aws-cdk-lib` writes.

When a Dependabot PR bumps the `aws-cdk` group (or you bump `aws-cdk-lib` manually), this test fails until you re-sync.
Fix it with one command on the PR branch:

```bash
npm ci && node scripts/sync-template-cdk.mjs
```

The script copies the installed `aws-cdk-lib` version into the root devDependency and the template pin, then regenerates
asset snapshots. Commit the resulting changes (if the root `package.json` changed, run `npm install` first so
`npm-shrinkwrap.json` is regenerated too). Note that `@dependabot rebase` recreates the PR branch and drops the sync
commit — just re-run the script.
