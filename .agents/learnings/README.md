# Agent Learnings

This directory contains durable, repository-specific constraints learned from completed agent runs. It is an evidence
log, not a scratchpad or a replacement for `AGENTS.md`.

Agents should consult relevant entries before changing or reviewing the affected area. Rules that apply broadly and
remain stable should be promoted to `AGENTS.md` through a normal pull request.

## Admission Criteria

A learning must:

- Link to the source run and the issue or pull request that supplied evidence.
- Describe a repeatable repository constraint, not a one-off implementation.
- Explain how the evidence changes a future implementation or review decision.
- Avoid credentials, customer data, internal-only links, and copied user data.
- Be submitted and reviewed through the normal pull request process.

Do not record style preferences, speculative advice, or conclusions based only on an agent's own output.

## Format

```markdown
# Actionable rule

- **Source run:** <run identifier>
- **Source issue or PR:** <public GitHub link>
- **Affected area:** <paths, subsystem, or workflow>

State the durable constraint and the action a future agent should take.

Explain the evidence, the previous failure mode, and why the rule generalizes.
```
