# Browser Tests

Browser tests use Playwright to test the web UI (agent inspector) served by `agentcore dev`.

## Prerequisites

- AWS credentials configured (`aws sts get-caller-identity` must succeed)
- `uv` on PATH
- Local build (`npm run build`)
- Playwright browsers installed: `npx playwright install chromium`

## Running

```bash
npm run test:browser
```

Test results and the HTML report are written to `browser-tests/test-results/` and `browser-tests/playwright-report/`
respectively. To view the report:

```bash
npx playwright show-report browser-tests/playwright-report
```

By default, tests run against the `@aws/agent-inspector` package from npm (in `node_modules`).

## Testing against a local agent-inspector build

To test with a local checkout of the agent-inspector (e.g. when developing new UI features or adding test IDs):

1. Clone `agent-inspector` as a sibling directory and build it
2. Run with `AGENT_INSPECTOR_PATH`:

```bash
AGENT_INSPECTOR_PATH=../agent-inspector/dist-assets npm run test:browser
```

## Test Structure

```
browser-tests/
├── playwright.config.ts  # Playwright configuration
├── global-setup.ts       # Creates test project, starts agentcore dev
├── global-teardown.ts    # Stops dev server, cleans up temp files
├── constants.ts          # Shared constants (env file path)
├── fixtures.ts           # Custom test fixtures (testEnv with port, project path)
└── tests/                # Test files
    ├── chat-invocation.test.ts
    ├── inspector-loads.test.ts
    ├── resources.test.ts
    ├── start-agent.test.ts
    └── traces.test.ts
```

The global setup creates a temporary project via `agentcore create`, starts `agentcore dev`, and writes connection
details to an env file. Tests read the env file via the `testEnv` fixture.

## Troubleshooting

### `Cannot find module '@playwright/test'`

Playwright is not installed. Run:

```bash
npm install
```

### `browserType.launch: Executable doesn't exist` (Playwright browsers)

Playwright browsers need to be downloaded after install. Run:

```bash
npx playwright install chromium
```
