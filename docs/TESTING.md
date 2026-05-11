# Testing Guide

## Quick Start

```bash
npm test              # Run unit tests
npm run test:watch    # Run tests in watch mode
npm run test:integ    # Run integration tests
npm run test:tui      # Run TUI integration tests (builds first)
npm run test:browser  # Run browser tests (requires AWS creds, uv, agentcore)
npm run test:all      # Run all tests (unit + integ)
```

## Test Types

| Type        | Description                                                                               | Docs                                                         |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Unit        | Co-located tests for individual modules, includes snapshot tests                          | [testing/unit-tests.md](testing/unit-tests.md)               |
| Integration | Runs the real CLI binary, asserts on local files and stdout (no AWS creds needed)         | [testing/integration-tests.md](testing/integration-tests.md) |
| TUI         | Full CLI in a pseudo-terminal — verifies screen output, keyboard navigation, wizard flows | [testing/tui-tests.md](testing/tui-tests.md)                 |
| Browser     | Playwright tests for the agent inspector web UI served by `agentcore dev`                 | [testing/browser-tests.md](testing/browser-tests.md)         |
| E2E         | Full user journey across the AWS boundary — deploy, invoke, status, logs, traces          | [testing/e2e-tests.md](testing/e2e-tests.md)                 |

## Manual Testing

Every change must be manually tested before submitting. See [testing/manual-testing.md](testing/manual-testing.md) for
instructions on building a local tarball and installing it without conflicting with global installs.

## Configuration

Test configuration is in `vitest.config.ts` using Vitest projects:

- **unit** project: `src/**/*.test.ts` (includes snapshot tests)
- **integ** project: `integ-tests/**/*.test.ts`
- **tui** project: `integ-tests/tui/**/*.test.ts` (TUI integration tests)
- Test timeout: 120 seconds
- Hook timeout: 120 seconds
