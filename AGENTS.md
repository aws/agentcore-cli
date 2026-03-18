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

## CLI Commands

- `create` - Create new AgentCore project
- `add` - Add resources (agent, memory, identity, target)
- `remove` - Remove resources (agent, memory, identity, target, all)
- `deploy` - Deploy infrastructure to AWS
- `status` - Check deployment status
- `dev` - Local development server (CodeZip: uvicorn with hot-reload; Container: Docker build + run with volume mount)
- `invoke` - Invoke agents (local or deployed)
- `package` - Package agent artifacts without deploying (zip for CodeZip, container image build for Container)
- `validate` - Validate configuration files
- `update` - Check for CLI updates
- `help` - Display help information

### Agent Types

- **Template agents**: Created from framework templates (Strands, LangChain_LangGraph, CrewAI, GoogleADK, OpenAIAgents,
  AutoGen)
- **BYO agents**: Bring your own code with `agentcore add agent --type byo`

### Build Types

- **CodeZip**: Python source is packaged into a zip artifact and deployed to AgentCore Runtime (default)
- **Container**: Agent is built as a Docker container image, deployed via ECR and CodeBuild. Requires a `Dockerfile` in
  the agent's code directory. Supported container runtimes: Docker, Podman, Finch.

## Primitives Architecture

All resource types (agent, memory, identity, gateway, mcp-tool) are modeled as **primitives** -- self-contained classes
in `src/cli/primitives/` that own the full add/remove lifecycle for their resource type.

Each primitive extends `BasePrimitive` and implements: `add()`, `remove()`, `previewRemove()`, `getRemovable()`,
`registerCommands()`, and `addScreen()`.

Current primitives:

- `AgentPrimitive` — agent creation (template + BYO), removal, credential resolution
- `MemoryPrimitive` — memory creation with strategies, removal
- `CredentialPrimitive` — credential/identity creation, .env management, removal
- `GatewayPrimitive` — MCP gateway creation/removal
- `GatewayTargetPrimitive` — MCP tool creation/removal with code generation

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

## TUI Harness

See `docs/tui-harness.md` for the full TUI harness usage guide (MCP tools, screen markers, examples, and error
recovery).
