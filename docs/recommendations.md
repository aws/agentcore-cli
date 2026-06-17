# Recommendations

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

## Encrypting Results with KMS

By default, recommendation results are encrypted with an AWS-managed key. To encrypt them with your own customer managed
key (CMK), pass its ARN with `--kms-key`:

```bash
agentcore run recommendation \
  -t system-prompt \
  -r MyAgent \
  -e Builtin.Correctness \
  --inline "You are a helpful assistant" \
  --kms-key arn:aws:kms:us-west-2:111122223333:key/12345678-1234-1234-1234-123456789012
```

The key must be in the same region as the recommendation, and the calling principal (and the AgentCore service) must
have `kms:Encrypt`/`kms:GenerateDataKey` permissions on it. Omit the flag to use the AWS-managed key.

## JSON Output

```bash
agentcore run recommendation -r MyAgent -e Builtin.Helpfulness --type system-prompt --inline "..." --json
```

Recommendations are fire-and-forget jobs: `run recommendation` returns `recommendationId` and an initial `status`
(`PENDING`/`IN_PROGRESS`) — the optimized `result` is **not** available immediately. Pass `--wait` to block until the
job finishes, or check later with `agentcore view recommendation <id> --json`, which returns the completed `result` with
`systemPromptRecommendationResult.recommendedSystemPrompt` (and `explanation`) or
`toolDescriptionRecommendationResult.tools`.

When using `--bundle-name`, the completed result also includes `configurationBundle.versionId` — the new bundle version.

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

Job records are saved in `.cli/jobs/recommendations/`. View past runs via the TUI:

```bash
agentcore
# Navigate to: Recommendations → History   (or View → Recommendation)
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
