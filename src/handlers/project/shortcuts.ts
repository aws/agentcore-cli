import z from "zod";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  type Memory,
} from "../../projectSchemas/memory";
import { InputValidationError } from "../../errors";
import { ScaffoldRuntimeInputSchema, type ScaffoldRuntimeInput } from "./types";

export const MEMORY_SHORTCUTS = {
  none: (_runtimeName: string) => undefined,
  shortTerm: (runtimeName: string): Memory => ({
    name: `${runtimeName}Memory`,
    eventExpiryDuration: 30,
    strategies: [],
  }),
  longAndShortTerm: (runtimeName: string): Memory => ({
    name: `${runtimeName}Memory`,
    eventExpiryDuration: 30,
    strategies: (["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"] as const).map(
      (type) => ({
        type,
        namespaceTemplates: DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[type],
        ...(type === "EPISODIC" && {
          reflectionNamespaceTemplates: DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
        }),
      }),
    ),
  }),
} satisfies Record<string, (runtimeName: string) => Memory | undefined>;

export type MemoryShortcutName = keyof typeof MEMORY_SHORTCUTS;

export const MEMORY_SHORTCUT_NAMES = Object.keys(MEMORY_SHORTCUTS) as unknown as readonly [
  MemoryShortcutName,
  ...MemoryShortcutName[],
];

type RuntimeTemplateShortcut = Omit<ScaffoldRuntimeInput, "memory"> & {
  memory: MemoryShortcutName;
};

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
    memory: "longAndShortTerm",
    entrypoint: "main.py",
    runtimeVersion: "PYTHON_3_14",
  },
} as const satisfies Record<string, RuntimeTemplateShortcut>;

export type RuntimeTemplateShortcutName = keyof typeof RUNTIME_TEMPLATE_SHORTCUTS;

export const RUNTIME_TEMPLATE_SHORTCUT_NAMES = Object.keys(
  RUNTIME_TEMPLATE_SHORTCUTS,
) as unknown as readonly [RuntimeTemplateShortcutName, ...RuntimeTemplateShortcutName[]];

type RuntimeTemplateOverrides = {
  runtimeName?: string;
  build?: ScaffoldRuntimeInput["build"];
  modelProvider?: ScaffoldRuntimeInput["modelProvider"];
  apiKey?: string;
  memory?: MemoryShortcutName;
};

export function resolveRuntimeTemplateShortcut(
  name: RuntimeTemplateShortcutName,
  overrides?: RuntimeTemplateOverrides,
): ScaffoldRuntimeInput {
  const template = RUNTIME_TEMPLATE_SHORTCUTS[name];
  const runtimeName = overrides?.runtimeName ?? template.runtimeName;
  const build = overrides?.build ?? template.build;
  const memoryShortcutName = overrides?.memory ?? template.memory;
  const memory = MEMORY_SHORTCUTS[memoryShortcutName](runtimeName);

  const input = {
    runtimeName,
    build,
    language: template.language,
    framework: template.framework,
    modelProvider: overrides?.modelProvider ?? template.modelProvider,
    ...(overrides?.apiKey !== undefined && { apiKey: overrides.apiKey }),
    ...(memory && { memory }),
    entrypoint: template.entrypoint,
    runtimeVersion: build === "CodeZip" ? "PYTHON_3_14" : undefined,
  };

  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
