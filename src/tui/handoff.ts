import type { Command } from "commander";
import { contextKey } from "../router";

// RequestTuiHandoff asks the TUI to close and then run a command, given as its
// path below the root (e.g. ["dev"]), exactly as if it had been typed.
export type RequestTuiHandoff = (commandPath: string[]) => void;

// Screens use this to leave the TUI for a command that owns the terminal
// itself, such as `dev`. The command runs only after Ink restores the normal
// terminal buffer.
export const TuiHandoffKey = contextKey<RequestTuiHandoff>("tui.handoff");

// handoffArgs builds the user arguments (Commander's `from: "user"`) that run
// `commandPath` under `root`, carrying
// over the global flags the user gave when launching the TUI (e.g. --region)
// so the handed-off command runs with the same settings.
export function handoffArgs(root: Command, commandPath: string[]): string[] {
  const globals: string[] = [];
  for (const option of root.options) {
    const name = option.attributeName();
    if (root.getOptionValueSource(name) !== "cli" || !option.long) continue;
    const value: unknown = root.getOptionValue(name);
    if (option.isBoolean()) {
      if (value === !option.negate) globals.push(option.long);
    } else if (Array.isArray(value)) {
      globals.push(option.long, ...value.map(String));
    } else if (value !== undefined) {
      globals.push(option.long, String(value));
    }
  }
  return [...commandPath, ...globals];
}
