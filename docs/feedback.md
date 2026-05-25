# Feedback

Send feedback about the AgentCore CLI directly from your terminal.

## When to use

| Use `agentcore feedback`               | Use [GitHub Issues](https://github.com/aws/agentcore-cli/issues) instead |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Quick comments, suggestions, papercuts | Bugs that need a conversation or repro steps                             |
| First impressions, onboarding friction | Regressions you want to track                                            |
| Sharing a screenshot of confusing UX   | Feature requests you want to discuss publicly                            |

## Syntax

```bash
# One-shot
agentcore feedback "your message" [--screenshot path/to/file.png] [--json]

# Multi-step wizard
agentcore feedback
```

The wizard walks through: message → optional screenshot → consent → submit. Press `Esc` to step back one phase.

## Screenshots

- Allowed types: `.png`, `.jpg`, `.jpeg`
- Maximum size: 100 MB

## Consent

Every submission requires interactive consent. The CLI displays:

> All feedback submissions, including any uploaded text and images, are subject to the AWS Customer Agreement
> (https://aws.amazon.com/agreement/). By submitting feedback, you agree that your submissions constitute "Suggestions"
> as defined in the AWS Customer Agreement.

Bare `Enter` defaults to **No**. The command refuses to submit when stdin is not a TTY (e.g. piped input, CI). There is
no flag that bypasses the prompt.

## What not to include

Do not paste credentials, secrets, account IDs, or customer data into the message, and do not attach screenshots that
show those values.

## Output

Plain mode prints a confirmation line on success. JSON mode (`--json`) prints a single line:

```json
{ "success": true, "id": "<uuid>", "timestamp": "<iso8601>", "reference": "<reference>" }
```

On failure the CLI exits with code 1 and prints a human-readable error, or `{"success": false, "error": "..."}` when
`--json` is set.
