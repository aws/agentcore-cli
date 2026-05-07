# Recommendations [preview]

Recommendations optimize your agent's system prompt or tool descriptions using historical traces as signal. The
recommendation service analyzes how your agent performed, then produces an improved version scored by an evaluator.

## Quick Start

```bash
# Optimize a system prompt (inline)
agentcore run recommendation \
  -r MyAgent \
  -e Builtin.Helpfulness \
  --type system-prompt \
  --inline "You are a helpful assistant."

# Optimize tool descriptions
agentcore run recommendation \
  -r MyAgent \
  --type tool-description \
  --tools "search:Searches the web" "calc:Does math"
```

## System Prompt Recommendations

### From inline text

```bash
agentcore run recommendation \
  -r MyAgent \
  -e Builtin.Helpfulness \
  --type system-prompt \
  --inline "You are a helpful assistant. Use tools when appropriate."
```

### From a file

```bash
agentcore run recommendation \
  -r MyAgent \
  -e Builtin.Helpfulness \
  --type system-prompt \
  --prompt-file ./system-prompt.txt
```

### From a config bundle

Read the current prompt from a deployed config bundle, optimize it, and write the result back as a new bundle version:

```bash
agentcore run recommendation \
  -r MyAgent \
  -e Builtin.Helpfulness \
  --type system-prompt \
  --bundle-name MyBundle \
  --bundle-version <version-id> \
  --system-prompt-json-path systemPrompt
```

The `--system-prompt-json-path` is the field name under `configuration` in the bundle (e.g. `systemPrompt`). The CLI
resolves it to the full path automatically using the component ARN from your deployed state.

> **JSONPath format:** The API uses dot notation (`$.{ARN}.configuration.{field}`), not standard JSONPath bracket
> notation. You don't need to worry about this — just pass the short field name and the CLI handles the resolution. If
> you need the full path for direct API calls, use `$.arn:aws:...:runtime/MyAgent.configuration.systemPrompt` (no
> brackets, no quotes around the ARN).

On success, the recommendation writes a new config bundle version with the optimized prompt. The agent picks it up on
the next invocation — no redeploy needed.

## Tool Description Recommendations

```bash
agentcore run recommendation \
  -r MyAgent \
  --type tool-description \
  --tools "add_numbers:Return the sum of two numbers" "search:Searches the web"
```

Returns optimized tool descriptions for each tool.

## Trace Source

By default, the recommendation service fetches traces from CloudWatch using a 7-day lookback. Customize with:

```bash
# Custom lookback window
agentcore run recommendation ... --lookback 14

# Specific sessions only
agentcore run recommendation ... --session-id <id-1> <id-2>

# From a local spans file (OTEL format)
agentcore run recommendation ... --spans-file ./traces.json
```

## JSON Output

```bash
agentcore run recommendation -r MyAgent -e Builtin.Helpfulness --type system-prompt --inline "..." --json
```

Returns `recommendationId`, `status`, and `result` with `systemPromptRecommendationResult.recommendedSystemPrompt` or
`toolDescriptionRecommendationResult.tools`.

When using `--bundle-name`, the result also includes `configurationBundle.versionId` — the new bundle version.

## End-to-End Workflow: Recommendation → Config Bundle → Invoke

1. Create agent with config bundle:

   ```bash
   agentcore create --name MyAgent --defaults --with-config-bundle
   agentcore deploy
   ```

2. Invoke a few times to generate traces:

   ```bash
   agentcore invoke --prompt "What is 2 + 3?"
   agentcore invoke --prompt "Tell me about Paris"
   ```

3. Run recommendation from config bundle:

   ```bash
   agentcore run recommendation \
     -r MyAgent -e Builtin.Helpfulness --type system-prompt \
     --bundle-name MyAgentConfig --bundle-version <version-id> \
     --system-prompt-json-path systemPrompt
   ```

4. Invoke again — the agent uses the optimized prompt without code changes:
   ```bash
   agentcore invoke --prompt "Who are you?"
   ```

## Viewing History

Results are saved in `.cli/recommendations/`. View past runs via the TUI:

```bash
agentcore
# Navigate to: Recommendations → History
```

## TUI Wizard

Run `agentcore` → Run → Recommendation for a guided flow:

1. Select recommendation type (system prompt or tool description)
2. Select agent
3. Select evaluator (system prompt only)
4. Choose input source (inline, file, or config bundle)
5. Choose trace source (CloudWatch or sessions)
6. Confirm and run

The TUI shows real-time progress and displays the recommended changes when complete, with an option to apply config
bundle updates.
