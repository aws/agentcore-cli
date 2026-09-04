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
  /** One line shown next to the template name in the create wizard. */
  description: string;
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
    description: "minimal Python agent on Bedrock, no framework",
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
    description: "Strands agent on Bedrock with memory",
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
    description: "Strands agent on Bedrock with memory",
    build: "Container",
    language: "Python",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
  },
  "agent-typescript-strands": {
    runtimeName: "agent_typescript_strands",
    description: "Strands agent on Bedrock with memory, in TypeScript",
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
    description: "LangChain agent on Bedrock",
    build: "CodeZip",
    language: "Python",
    framework: "langchain",
    modelProvider: "Bedrock",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "PYTHON_3_14",
  },
  "agent-typescript-vercel": {
    runtimeName: "agent_typescript_vercel",
    description: "minimal Vercel AI SDK agent on Bedrock, in TypeScript",
    build: "CodeZip",
    language: "TypeScript",
    framework: "vercelai",
    modelProvider: "Bedrock",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "NODE_22",
  },
  "mcp-python-fastmcp": {
    runtimeName: "mcp_python_fastmcp",
    description: "MCP server exposing tools via FastMCP",
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
    description: "Strands agent speaking the A2A protocol on Bedrock",
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
    description: "Strands agent speaking the AG-UI protocol on Bedrock",
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

const PROTOCOL_ORDER: Record<NonNullable<ScaffoldRuntimeInput["protocol"]>, number> = {
  HTTP: 0,
  A2A: 1,
  AGUI: 2,
  MCP: 3,
};
const LANGUAGE_ORDER: Record<ScaffoldRuntimeInput["language"], number> = {
  Python: 0,
  TypeScript: 1,
};
const FRAMEWORK_ORDER: Record<ScaffoldRuntimeInput["framework"], number> = {
  strands: 0,
  langchain: 1,
  vercelai: 2,
  none: 3,
};
const BUILD_ORDER: Record<ScaffoldRuntimeInput["build"], number> = { CodeZip: 0, Container: 1 };

function templateSortKey(template: RuntimeTemplateShortcut): number[] {
  return [
    PROTOCOL_ORDER[template.protocol ?? "HTTP"],
    LANGUAGE_ORDER[template.language],
    FRAMEWORK_ORDER[template.framework],
    BUILD_ORDER[template.build],
  ];
}

/** Template names ordered by protocol, then language, framework, and build, for `--template` help and the wizard. */
export const RUNTIME_TEMPLATE_SHORTCUT_NAMES = (
  Object.keys(RUNTIME_TEMPLATE_SHORTCUTS) as RuntimeTemplateShortcutName[]
).sort((a, b) => {
  const left = templateSortKey(RUNTIME_TEMPLATE_SHORTCUTS[a]);
  const right = templateSortKey(RUNTIME_TEMPLATE_SHORTCUTS[b]);
  return left.map((value, i) => value - right[i]!).find((diff) => diff !== 0) ?? 0;
}) as unknown as readonly [RuntimeTemplateShortcutName, ...RuntimeTemplateShortcutName[]];

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
