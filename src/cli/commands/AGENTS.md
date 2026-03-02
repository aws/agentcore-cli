# Command Descriptions

This file defines context around specific commands surfaced by the CLI and related functionalities

## File Naming Convention

Each command directory follows a standardized structure:

```
commands/{name}/
├── command.tsx    # Commander registration (required)
├── action.ts      # Business logic and handlers (optional)
├── index.ts       # Re-exports (required)
└── {Component}.tsx # React components for TUI (optional)
```

## Separation of Concerns

The `command.tsx` file must be boring Commander registration only:

- Define flags, help text, aliases
- Invoke a handler from `action.ts` or render a TUI screen
- Must NOT contain behavior or decision-making logic

If removing a command file would remove behavior, the design is wrong.

## Three-Layer Architecture

1. **Command File** (`commands/{name}/command.tsx`)
   - Commander registration only
   - Parses CLI args and invokes handler or TUI

2. **Primitives** (`primitives/`) — for resource add/remove commands
   - Each resource type (agent, memory, identity, gateway, mcp-tool) has a primitive class
   - Primitives own add/remove logic, CLI subcommand registration, and TUI screen routing
   - `add` and `remove` commands delegate to primitives via `primitive.registerCommands()`
   - See `src/cli/AGENTS.md` for the full primitives architecture

3. **Action File** (`commands/{name}/action.ts`) — for non-resource commands
   - Contains business logic specific to this command (e.g., deploy, invoke, package)
   - Defines interfaces (e.g., `InvokeContext`, `PackageResult`)
   - Implements handlers (e.g., `handleInvoke`, `loadPackageConfig`)
   - Must be UI-agnostic where possible

4. **Operation** (`operations/{domain}/`)
   - Shared utilities consumed by primitives and commands (schema mapping, template rendering)
   - Must be UI-agnostic (no Ink, no process.exit)
   - Reusable by TUI screens, primitives, and command handlers alike

## Good vs Bad Examples

```typescript
// GOOD: Command file only registers and delegates
// commands/deploy/command.tsx
export const registerDeploy = (program: Command) => {
  program
    .command('deploy')
    .description('Deploy AgentCore agent')
    .action(() => {
      render(<DeployScreen onExit={() => process.exit(0)} />);
    });
};

// GOOD: Logic in action.ts, command.tsx just wires it up
// commands/invoke/action.ts
export async function loadInvokeConfig(): Promise<InvokeContext> { ... }
export function handleInvoke(context: InvokeContext): InvokeResult { ... }

// commands/invoke/command.tsx
export const registerInvoke = (program: Command) => {
  program.command('invoke').action(async () => {
    const context = await loadInvokeConfig();
    const result = handleInvoke(context);
    render(<Text>{result.agentName}</Text>);
  });
};

// BAD: Command file contains domain logic
export const registerPackage = (program: Command) => {
  program.command('package').action(async () => {
    const config = await loadConfig();           // should be in action.ts
    const agents = filterAgents(config, flag);   // should be in action.ts
    await packRuntime(agent, options);           // should be in action.ts
  });
};
```

## Command-Specific Resources

Some commands have additional files for their specific needs:

- `commands/create/` - Contains `schema-mapper.ts` and `write-agent-to-project.ts` for agent creation logic
- `commands/init/` - Contains `InitScreen.tsx` for the initialization UI component
