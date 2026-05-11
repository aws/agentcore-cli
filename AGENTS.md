# AgentCore CLI

CLI tool for Amazon Bedrock AgentCore. Manages agent infrastructure lifecycle.

## Package Structure

```
src/
├── index.ts           # Library entry - exports ConfigIO, types
├── schema/            # Schema definitions with Zod validators
├── lib/               # Shared utilities (ConfigIO, packaging)
├── cli/               # CLI implementation
│   ├── primitives/    # Resource primitives (add/remove logic per resource type)
│   ├── commands/      # CLI commands (thin Commander registration)
│   ├── tui/           # Terminal UI (Ink/React)
│   ├── operations/    # Shared business logic (schema mapping, deploy, etc.)
│   ├── cdk/           # CDK toolkit wrapper for programmatic CDK operations
│   └── templates/     # Project templating
└── assets/            # Template assets vended to users
```

Note: CDK L3 constructs are in a separate package `@aws/agentcore-cdk`.

## Global Options

These options are available on all commands:

- `-h, --help` - Show help for any command
- `--version` - Print CLI version (root command only)

## CLI Commands

- `create` - Create new AgentCore project
- `add` - Add resources (agent, memory, credential, evaluator, online-eval, gateway, gateway-target, policy-engine,
  policy)
- `remove` - Remove resources (agent, memory, credential, evaluator, online-eval, gateway, gateway-target,
  policy-engine, policy, all)
- `deploy` - Deploy infrastructure to AWS
- `status` - Check deployment status
- `dev` - Local development server (CodeZip: uvicorn with hot-reload; Container: Docker build + run with volume mount)
- `invoke` - Invoke agents (local or deployed)
- `run eval` - Run on-demand evaluation against agent sessions
- `evals history` - View past eval run results
- `fetch access` - Fetch access info for a deployed gateway or agent
- `import` - Import resources from a Bedrock AgentCore Starter Toolkit project
- `pause online-eval` - Pause (disable) a deployed online eval config
- `resume online-eval` - Resume (enable) a paused online eval config
- `logs` - Stream or search agent runtime logs
- `logs evals` - Stream or search online eval logs
- `traces list` - List recent traces for a deployed agent
- `traces get` - Download a trace to a JSON file
- `package` - Package agent artifacts without deploying (zip for CodeZip, container image build for Container)
- `validate` - Validate configuration files
- `update` - Check for CLI updates
- `help` - Display help information

### Agent Types

- **Template agents**: Created from framework templates (Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents)
- **BYO agents**: Bring your own code with `agentcore add agent --type byo`
- **Imported agents**: Import from Bedrock Agents with `agentcore add agent --type import`

### Build Types

- **CodeZip**: Python source is packaged into a zip artifact and deployed to AgentCore Runtime (default)
- **Container**: Agent is built as a Docker container image, deployed via ECR and CodeBuild. Requires a `Dockerfile` in
  the agent's code directory. Supported container runtimes: Docker, Podman, Finch.

## Primitives Architecture

All resource types (agent, memory, credential, evaluator, online-eval, gateway, gateway-target, policy-engine, policy)
are modeled as **primitives** -- self-contained classes in `src/cli/primitives/` that own the full add/remove lifecycle
for their resource type. Resources support config-driven tagging via `agentcore.json`, with tags flowing through to
deployed CloudFormation resources.

Each primitive extends `BasePrimitive` and implements: `add()`, `remove()`, `previewRemove()`, `getRemovable()`,
`registerCommands()`, and `addScreen()`.

Current primitives:

- `AgentPrimitive` — agent creation (template + BYO), removal, credential resolution
- `MemoryPrimitive` — memory creation with strategies, removal
- `CredentialPrimitive` — credential creation, .env management, removal
- `EvaluatorPrimitive` — custom evaluator creation/removal with cross-reference validation
- `OnlineEvalConfigPrimitive` — online eval config creation/removal
- `GatewayPrimitive` — gateway creation/removal
- `GatewayTargetPrimitive` — gateway target creation/removal with code generation
- `PolicyEnginePrimitive` — Cedar policy engine creation/removal
- `PolicyPrimitive` — Cedar policy creation/removal within policy engines

Singletons are created in `registry.ts` and wired into CLI commands via `cli.ts`. See `src/cli/AGENTS.md` for details on
adding new primitives.

## Vended CDK Project

When users run `agentcore create`, we vend a CDK project at `agentcore/cdk/` that:

- Imports `@aws/agentcore-cdk` for L3 constructs
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

- `@aws/agentcore-cdk` - CDK constructs used by vended projects

## Code Style

- Never use inline imports. Imports must always go at the top of the file.
- Wheverever there is a requirement to use something that returns a success result and an error message you must use
  this format

```javascript
{ success: Boolean, error?:string}
```

- Always look for existing types before creating a new type inline.
- Re-usable constants must be defined in a constants file in the closest sensible subdirectory.

## Telemetry

New features must include telemetry instrumentation. See `src/cli/telemetry/README.md` for how to add metrics.

## Multi-Partition Support (GovCloud, China)

The CLI supports multiple AWS partitions (commercial, GovCloud, China) through a central utility at
`src/cli/aws/partition.ts`. This module maps region prefixes to partition-specific values.

### Rules

- **Never hardcode `arn:aws:`** in ARN construction. Use `arnPrefix(region)` from `src/cli/aws/partition.ts`.
- **Never hardcode `amazonaws.com`** in endpoint URLs. Use `serviceEndpoint(service, region)` or `dnsSuffix(region)`.
- **Never hardcode `console.aws.amazon.com`** in console URLs. Use `consoleDomain(region)`.
- **ARN regex patterns** must use `arn:[^:]+:` (not `arn:aws:`) to match any partition.
- **Static JSON assets** (e.g., IAM policies in `src/assets/`) cannot use TypeScript utilities — use `arn:*:` as the
  partition wildcard since IAM evaluates it across all partitions.

### Adding a New Region

Update these files in the CLI repo:

1. `src/schema/schemas/aws-targets.ts` — add to `AgentCoreRegionSchema` enum
2. `src/schema/llm-compacted/aws-targets.ts` — add to `AgentCoreRegion` type union
3. `src/schema/schemas/__tests__/aws-targets.test.ts` — add to `validRegions` array
4. `src/cli/operations/agent/import/constants.ts` — add to `BEDROCK_REGIONS` (if applicable to Bedrock Agent import)

Update these files in the CDK repo (`@aws/agentcore-cdk`):

5. `src/schema/schemas/aws-targets.ts` — add to `AgentCoreRegionSchema` enum
6. `src/schema/llm-compacted/aws-targets.ts` — add to `AgentCoreRegion` type union

Then run `npm run test:update-snapshots` in the CLI repo if any asset files changed.

### Adding a New Partition

1. Add a new entry to `PARTITION_CONFIGS` in `src/cli/aws/partition.ts` with the region prefix, partition name, DNS
   suffix, and console domain.
2. Add tests for the new partition in `src/cli/aws/__tests__/partition.test.ts`.
3. Update `src/assets/cdk/cdk.json` — add the partition to `@aws-cdk/core:target-partitions`.
4. Run `npm run test:update-snapshots` to update asset snapshots.

## TUI Harness

See `docs/tui-harness.md` for the full TUI harness usage guide (MCP tools, screen markers, examples, and error
recovery).
