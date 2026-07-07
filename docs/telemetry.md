# Telemetry

The AgentCore CLI collects anonymous usage analytics by default to help improve the tool. You can opt out at any time.

## What is collected

One event per command you run, containing:

- The command name (e.g. `add.agent`, `deploy`, `invoke`) and whether it succeeded or failed.
- On failure: a category for the error (e.g. `ValidationError`, `AccessDeniedError`) and whether it originated from your
  input, the CLI, or the service.
- A small set of structured attributes describing the shape of the command — for example, the framework and model
  provider when creating an agent, or the number of resources at deploy time. These are restricted to fixed enums,
  booleans, and counts.
- Per-session metadata: an anonymous installation ID (random UUID stored in `~/.agentcore/config.json`), a session ID
  for each CLI session or TUI session, the CLI version, mode (`cli` or `tui`), and basic environment info (OS family and
  version, host architecture, and Node.js version). Note: the session ID from telemetry is describing the CLI lifecycle
  and is independent from AgentCore Runtime and Memory session IDs. These are a subset of the resource attributes
  attached to every event — see the audit-mode output for the full set of keys.

The full list of attributes for every command lives in
[`src/cli/telemetry/schemas/`](https://github.com/aws/agentcore-cli/tree/main/src/cli/telemetry/schemas).

## What is not collected

- No free-form text. Strings like file paths, agent names, prompts, or invocation payloads are never sent.
- No AWS account IDs, ARNs, or credentials.
- No source code or configuration file contents.

## Inspect what's being sent

Audit mode logs every telemetry event locally so you can see exactly what is be sent.

```bash
agentcore config telemetry.audit true
```

Events are appended as JSON lines to `~/.agentcore/telemetry/<entrypoint>-<sessionId>.jsonl`. Disable with:

```bash
agentcore config telemetry.audit false
```

You can also set `AGENTCORE_TELEMETRY_AUDIT=1` for a single session.

## Check your current status

```bash
agentcore telemetry status
```

Prints whether telemetry is enabled and where the setting comes from (environment variable, global config, or default).

## Opt in / opt out

```bash
# Opt out
agentcore config telemetry.enabled false

# Opt in
agentcore config telemetry.enabled true
```

For a single session, set `AGENTCORE_TELEMETRY_DISABLED=1` in your environment.

Precedence (highest first): environment variable → `~/.agentcore/config.json` → default (enabled).
