// The evaluation levels accepted by `--level` on evaluator create. Shared by both
// evaluator types (LLM-as-a-Judge and code-based), which take the same values.
export const LEVELS = ["SESSION", "TRACE", "TOOL_CALL"] as const;
