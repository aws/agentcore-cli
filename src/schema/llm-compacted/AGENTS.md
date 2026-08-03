# LLM-Compacted Schema Maintenance

This directory contains **manually maintained** TypeScript type definitions optimized for LLM consumption.

## How It Works

1. The CLI embeds these `.ts` files as text through the esbuild text-loader plugin
2. During `create`, they're written to the user's `agentcore/.llm-context/` directory
3. AI coding assistants read these files when editing AgentCore JSON configs

## Keeping In Sync With Zod Schemas

When Zod schemas in `schemas/` are updated, manually update the corresponding file here:

| Compacted File   | Zod Source Files                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `agentcore.ts`   | `schemas/agentcore-project.ts`, `schemas/agent-env.ts`, `schemas/mcp.ts`, and `schemas/primitives/*` |
| `aws-targets.ts` | `schemas/aws-targets.ts`                                                                             |

## Critical: Enum and Regex Accuracy

**Every enum (union type) and regex pattern MUST be exactly correct.**

On every update:

1. **Re-verify ALL union types** match the Zod enum values exactly
2. **Re-verify ALL regex patterns** match the Zod regex constraints exactly
3. **Re-verify ALL min/max values** match the Zod constraints exactly

Incorrect enums or regex will cause agents to generate invalid JSON that fails validation.

## Update Checklist

- [ ] Add new fields to the relevant interface
- [ ] Add validation constraint comments (`@regex`, `@min`, `@max`)
- [ ] **Re-check ALL enum union types match Zod source exactly**
- [ ] **Re-check ALL regex patterns match Zod source exactly**
- [ ] Keep each file self-contained (duplicate shared types if needed)

## Format Guidelines

### Constraint Comments

```typescript
name: string; // @regex ^[a-zA-Z][a-zA-Z0-9]{0,63}$ @max 48
eventExpiryDuration: number; // @min 7 @max 365 (days)
targets: Target[]; // @min 1 - at least one required
```

### File Structure

1. Header with JSON file reference and read-only notice
2. Root schema interface at top
3. Component types below
4. Enums as union types (`type Foo = 'A' | 'B'`)
