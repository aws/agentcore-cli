# LLM Context Files

**DO NOT EDIT THESE FILES** - They are read-only reference for AI coding assistants.

## Files

| File             | JSON Config        | Purpose                               |
| ---------------- | ------------------ | ------------------------------------- |
| `agentcore.ts`   | `agentcore.json`   | Project resources, including gateways |
| `aws-targets.ts` | `aws-targets.json` | Deployment targets (account + region) |

## Usage

When editing AgentCore JSON config files, reference the corresponding `.ts` file here for type definitions, exact enum
values, defaults, and validation constraints (marked with `@regex`, `@min`, and `@max`). Run `agentcore validate` after
making changes.
