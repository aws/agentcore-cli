# Configuration Bundles [preview]

Config bundles are versioned configurations that store your agent's runtime settings — system prompt, tool descriptions,
model parameters, or any custom keys. Instead of hardcoding values in your agent code, your agent reads its config at
invocation time from whichever bundle version is active.

## Concepts

| Concept       | Description                                                                         |
| ------------- | ----------------------------------------------------------------------------------- |
| **Bundle**    | A named container for component configurations, stored in `agentcore.json`          |
| **Version**   | An immutable snapshot of a bundle's configuration, created on each deploy or update |
| **Branch**    | A named lineage within a bundle (e.g. `mainline`, `experiment-1`)                   |
| **Component** | A runtime or gateway whose configuration is managed by the bundle                   |

## Creating a Config Bundle

### With agent creation

Create an agent with a pre-wired config bundle that injects system prompt and tool descriptions at runtime:

```bash
agentcore create --name MyProject --defaults --with-config-bundle
```

This creates a `{AgentName}Config` bundle with smart defaults and generates a template that uses
`BedrockAgentCoreContext.get_config_bundle()` to read config at runtime.

### Standalone

```bash
agentcore add config-bundle \
  --name MyBundle \
  --description "Production configuration" \
  --components '{"{{runtime:MyAgent}}": {"configuration": {"systemPrompt": "You are helpful.", "temperature": 0.7}}}' \
  --branch mainline \
  --commit-message "Initial config" \
  --json
```

The `{{runtime:MyAgent}}` placeholder resolves to the real runtime ARN at deploy time.

### Via TUI

Run `agentcore` → Add → select "Configuration Bundle", or select "Config bundle" in the Advanced Configuration step when
adding an agent.

## Deploying

```bash
agentcore deploy
```

On deploy, the CLI creates or updates the config bundle in the API and stores the bundle ID, ARN, and version ID in
`deployed-state.json`.

## Managing Versions

### List versions

```bash
agentcore cb versions --bundle MyBundle
```

Shows version history grouped by branch with commit messages, timestamps, and parent lineage.

### Diff two versions

```bash
agentcore cb diff --bundle MyBundle --from <version-id-1> --to <version-id-2>
```

### Create a branch

```bash
agentcore cb create-branch --bundle MyBundle --branch experiment-1
```

Creates a new branch from the latest version (or a specific version with `--from`).

## Updating Without Redeploying Code

Edit the `systemPrompt` or other fields in `agentcore.json` under `configBundles`, then:

```bash
agentcore deploy
```

A new version is created in the API. The next invocation picks up the new config automatically — no code changes needed.

## How It Works at Runtime

When you invoke an agent with an associated config bundle, the CLI passes the bundle ARN and version as W3C baggage
headers. The SDK's `BedrockAgentCoreContext.get_config_bundle()` reads the baggage, fetches the config from the API
(cached per version), and makes it available to your agent code.

The generated template uses a `ConfigBundleHook` (Strands) or `ConfigBundleCallback` (LangGraph) to inject the system
prompt and tool descriptions before each invocation.

## Bundle Name in agentcore.json

The CLI prefixes your bundle name with the project name when creating it in the API (e.g. `MyProject` + `MyBundle` →
`MyProjectMyBundle`). You always use the local name (`MyBundle`) in CLI commands — the CLI resolves the prefix
automatically.

## JSON Output

All commands support `--json` for scripting:

```bash
agentcore cb versions --bundle MyBundle --json
agentcore cb diff --bundle MyBundle --from v1 --to v2 --json
agentcore cb create-branch --bundle MyBundle --branch exp-1 --json
```
