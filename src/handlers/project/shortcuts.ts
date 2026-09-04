import z from "zod";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  type Memory,
} from "../../projectSchemas/memory";
import { InputValidationError } from "../../errors";
import { ScaffoldRuntimeInputSchema, type ModelProvider, type ScaffoldRuntimeInput } from "./types";

/** The default memory that templates ship with. */
export function getDefaultMemorySpec(runtimeName: string): Memory {
  return {
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
  };
}

type RuntimeTemplateShortcut = {
  runtimeName: string;
  build: ScaffoldRuntimeInput["build"];
  language: ScaffoldRuntimeInput["language"];
  framework: ScaffoldRuntimeInput["framework"];
  protocol?: ScaffoldRuntimeInput["protocol"];
  modelProvider?: ModelProvider;
  /** Ships with memory. */
  includesMemory: boolean;
  /** Accepts --model-provider / --api-key overrides; Bedrock-only otherwise. */
  supportsModelProviderOverride: boolean;
  runtimeVersion?: NonNullable<ScaffoldRuntimeInput["runtimeVersion"]>;
};

/**
 * The runtime templates. Only agent-python-strands offers a container build (its
 * `-container` shortcut renders the same source with a Dockerfile); every other
 * template is CodeZip-only.
 */
export const RUNTIME_TEMPLATE_SHORTCUTS = {
  "agent-python-minimal": {
    runtimeName: "agent_python_minimal",
    build: "CodeZip",
    language: "Python",
    framework: "none",
    modelProvider: "Bedrock",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
  "agent-python-strands": {
    runtimeName: "agent_python_strands",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
    runtimeVersion: "PYTHON_3_14",
  },
  "agent-python-strands-container": {
    runtimeName: "agent_python_strands_container",
    build: "Container",
    language: "Python",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
  },
  "agent-typescript-strands": {
    runtimeName: "agent_typescript_strands",
    build: "CodeZip",
    language: "TypeScript",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: false,
    runtimeVersion: "NODE_22",
  },
  "agent-python-langchain": {
    runtimeName: "agent_python_langchain",
    build: "CodeZip",
    language: "Python",
    framework: "langchain",
    modelProvider: "Bedrock",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
  "mcp-python-fastmcp": {
    runtimeName: "mcp_python_fastmcp",
    build: "CodeZip",
    language: "Python",
    framework: "none",
    protocol: "MCP",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
  "a2a-python-strands": {
    runtimeName: "a2a_python_strands",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    protocol: "A2A",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
  "agui-python-strands": {
    runtimeName: "agui_python_strands",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    protocol: "AGUI",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
} as const satisfies Record<string, RuntimeTemplateShortcut>;

export type RuntimeTemplateShortcutName = keyof typeof RUNTIME_TEMPLATE_SHORTCUTS;

export const RUNTIME_TEMPLATE_SHORTCUT_NAMES = Object.keys(
  RUNTIME_TEMPLATE_SHORTCUTS,
) as unknown as readonly [RuntimeTemplateShortcutName, ...RuntimeTemplateShortcutName[]];

/** The empty template scaffolds a project with no runtime and no harness. */
export const EMPTY_TEMPLATE_NAME = "empty";

export type TemplateName = RuntimeTemplateShortcutName | typeof EMPTY_TEMPLATE_NAME;

/** Every `--template` value: the runtime shortcuts plus the empty project template. */
export const PROJECT_TEMPLATE_NAMES = [
  ...RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  EMPTY_TEMPLATE_NAME,
] as unknown as readonly [TemplateName, ...TemplateName[]];

type RuntimeTemplateOverrides = {
  runtimeName?: string;
  modelProvider?: ModelProvider;
  apiKey?: string;
};

export function resolveRuntimeTemplateShortcut(
  name: RuntimeTemplateShortcutName,
  overrides?: RuntimeTemplateOverrides,
): ScaffoldRuntimeInput {
  const template: RuntimeTemplateShortcut = RUNTIME_TEMPLATE_SHORTCUTS[name];
  const runtimeName = overrides?.runtimeName ?? template.runtimeName;

  const input = {
    runtimeName,
    build: template.build,
    language: template.language,
    framework: template.framework,
    protocol: template.protocol,
    modelProvider: template.supportsModelProviderOverride
      ? (overrides?.modelProvider ?? template.modelProvider)
      : template.modelProvider,
    ...(overrides?.apiKey !== undefined && { apiKey: overrides.apiKey }),
    ...(template.includesMemory && { memory: getDefaultMemorySpec(runtimeName) }),
    runtimeVersion: template.runtimeVersion,
  };

  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
