# AgentCore CLI

CLI tool for Amazon Bedrock AgentCore. Manages agent infrastructure lifecycle.

## Package Structure

```
src/
├── index.ts           # Library entry - exports ConfigIO, types
├── schema/            # Schema definitions with Zod validators
├── lib/               # Shared utilities (ConfigIO, packaging)
├── cli/               # CLI implementation
│   ├── commands/      # CLI commands
│   ├── tui/           # Terminal UI (Ink/React)
│   ├── operations/    # Business logic
│   ├── cdk/           # CDK toolkit wrapper for programmatic CDK operations
│   └── templates/     # Project templating
└── assets/            # Template assets vended to users
```

Note: CDK L3 constructs are in a separate package `@aws/agentcore-l3-cdk-constructs`.

## CLI Commands

- `create` - Create new AgentCore project
- `deploy` - Deploy infrastructure to AWS
- `dev` - Local development server
- `invoke` - Invoke deployed agents
- `status` - Check deployment status

## Vended CDK Project

When users run `agentcore create`, we vend a CDK project at `agentcore/cdk/` that:

- Imports `@aws/agentcore-l3-cdk-constructs` for L3 constructs
- Reads schema files and synthesizes CloudFormation

## Library Exports

This package exports utilities for programmatic use:

- `ConfigIO` - Read/write schema files
- Schema types - `AgentEnvSpec`, `AgentCoreProjectSpec`, etc.
- `findConfigRoot()` - Locate agentcore/ directory

## Testing

### Unit Tests

```bash
npm test              # Run unit tests
npm run test:unit     # Same as above
npm run test:integ    # Run integration tests
```

### Snapshot Tests

Asset files in `src/assets/` are protected by snapshot tests. When modifying templates:

```bash
npm run test:update-snapshots  # Update snapshots after intentional changes
```

See `docs/TESTING.md` for details.

## Related Package

- `@aws/agentcore-l3-cdk-constructs` - CDK constructs used by vended projects
