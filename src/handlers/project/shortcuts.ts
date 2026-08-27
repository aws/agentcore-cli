import z from "zod";
import { InputValidationError } from "../../errors";
import { ScaffoldRuntimeInputSchema, type ScaffoldRuntimeInput } from "./types";

export const RUNTIME_TEMPLATE_SHORTCUTS = {
  "hello-world-python": {
    runtimeName: "hello_world",
    build: "CodeZip",
    language: "Python",
    framework: "none",
    modelProvider: "Bedrock",
    memory: "none",
    entrypoint: "main.py",
    runtimeVersion: "PYTHON_3_14",
  },
  "hello-world-python-container": {
    runtimeName: "hello_world",
    build: "Container",
    language: "Python",
    framework: "none",
    modelProvider: "Bedrock",
    memory: "none",
    entrypoint: "main.py",
  },
  "strands-python": {
    runtimeName: "strands_agent",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    modelProvider: "Bedrock",
    memory: "none",
    entrypoint: "main.py",
    runtimeVersion: "PYTHON_3_14",
  },
} as const satisfies Record<string, ScaffoldRuntimeInput>;

export type RuntimeTemplateShortcutName = keyof typeof RUNTIME_TEMPLATE_SHORTCUTS;

export const RUNTIME_TEMPLATE_SHORTCUT_NAMES = Object.keys(
  RUNTIME_TEMPLATE_SHORTCUTS,
) as unknown as readonly [RuntimeTemplateShortcutName, ...RuntimeTemplateShortcutName[]];

type RuntimeTemplateOverrides = Partial<
  Pick<
    ScaffoldRuntimeInput,
    "runtimeName" | "build" | "modelProvider" | "apiKey" | "memory" | "runtimeVersion"
  >
>;

export function resolveRuntimeTemplateShortcut(
  name: RuntimeTemplateShortcutName,
  overrides: RuntimeTemplateOverrides,
): ScaffoldRuntimeInput {
  const input = { ...RUNTIME_TEMPLATE_SHORTCUTS[name], ...overrides };

  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
