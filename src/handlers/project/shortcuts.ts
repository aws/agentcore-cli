import z from "zod";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  defaultMemoryName,
  type Memory,
} from "../../projectSchemas/memory";
import { InputValidationError } from "../../errors";
import type { AgentCoreGateway } from "../../projectSchemas/gateway";
import { DEFAULT_MODEL_IDS } from "../../projectSchemas/runtime";
import { boxGatewayName } from "../../projectSchemas/project";
import { ScaffoldRuntimeInputSchema, type ModelProvider, type ScaffoldRuntimeInput } from "./types";
import type { RuntimeTemplateProfile } from "./templateProfile";
import { BMA_TEMPLATE_NAME, BMA_TEMPLATE_PROFILE } from "./bma";

/** The default memory that templates ship with. */
export function getDefaultMemorySpec(runtimeName: string): Memory {
  return {
    name: defaultMemoryName(runtimeName),
    eventExpiryDuration: 30,
    strategies: (["SEMANTIC", "EPISODIC"] as const).map((type) => ({
      type,
      namespaceTemplates: DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[type],
      ...(type === "EPISODIC" && {
        reflectionNamespaceTemplates: DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
      }),
    })),
  };
}

/** The name of the Bedrock model target in a runtime's Box gateway entry. */
export const BOX_GATEWAY_BEDROCK_TARGET_NAME = "bedrock";

/**
 * The region of the Bedrock target when the command resolved none (a caller
 * that passes no region, such as a test). `create` and `add runtime` pass the
 * region they resolved (flag, AWS_REGION, then the profile), which is the
 * region a first `deploy` uses when aws-targets.json is empty.
 */
export const BOX_GATEWAY_BEDROCK_DEFAULT_REGION = "us-west-2";

/**
 * The entry that adds a passthrough target for the Bedrock model endpoint in
 * `region` to the runtime's Box gateway, `<runtime>-box`, which the CDK library
 * makes for each runtime of a Box project. The entry has the settings `agentcore
 * add gateway-target` gives one, which are the Box gateway's own. The target
 * signs with the gateway's role, which needs Bedrock permissions of its own.
 */
export function getBoxGatewayBedrockEntry(
  runtimeName: string,
  region: string = BOX_GATEWAY_BEDROCK_DEFAULT_REGION,
): AgentCoreGateway {
  return {
    name: boxGatewayName(runtimeName),
    protocolType: "None",
    authorizerType: "AWS_IAM",
    // The value the gateway schema fills in; it has no effect without MCP.
    enableSemanticSearch: true,
    exceptionLevel: "NONE",
    targets: [
      {
        name: BOX_GATEWAY_BEDROCK_TARGET_NAME,
        targetType: "passthrough",
        passthrough: {
          endpoint: `https://bedrock-runtime.${region}.amazonaws.com`,
          protocolType: "CUSTOM",
        },
        outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region },
      },
    ],
  };
}

/**
 * The Box gateway entry that a scaffolded runtime of a Box project starts with,
 * or undefined. A runtime whose agent calls Bedrock (the Bedrock provider, or
 * LiteLLM on a `bedrock/` model) gets the Bedrock target. A runtime with no
 * model provider (an MCP server, BMA) calls no model, and another provider's
 * endpoint takes an API key that the CLI has no credential for, so those get
 * none; their Box gateway still exists. `create` and `add runtime` both call
 * this where they write the spec, so the two give a runtime the same entry.
 */
export function boxGatewayEntryForRuntime(
  input: Pick<ScaffoldRuntimeInput, "runtimeName" | "modelProvider" | "modelId">,
  region?: string,
): AgentCoreGateway | undefined {
  if (input.modelProvider === undefined || !callsBedrockModel(input)) return undefined;
  return getBoxGatewayBedrockEntry(input.runtimeName, region);
}

/**
 * Whether the scaffolded agent calls Bedrock for its model: the Bedrock
 * provider, or LiteLLM with a `bedrock/` model id (its default).
 */
export function callsBedrockModel(input: Pick<ScaffoldRuntimeInput, "modelProvider" | "modelId">) {
  const provider = input.modelProvider ?? "Bedrock";
  if (provider === "Bedrock") return true;
  if (provider !== "LiteLLM") return false;
  return (input.modelId ?? DEFAULT_MODEL_IDS.LiteLLM).startsWith("bedrock/");
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
  /** Accepts --model-provider / --model-id / --api-key / --api-base overrides; Bedrock-only otherwise. */
  supportsModelProviderOverride: boolean;
  runtimeVersion?: NonNullable<ScaffoldRuntimeInput["runtimeVersion"]>;
  /** Exceptional runtime and dependency behavior for this template. */
  profile?: RuntimeTemplateProfile;
};

/**
 * The runtime templates. agent-python-strands offers both CodeZip and container
 * builds; Bedrock Managed Agents is a specialized container-only environment.
 * Every other template is CodeZip-only.
 */
export const RUNTIME_TEMPLATE_SHORTCUTS = {
  "agent-python-minimal": {
    runtimeName: "agent_python_minimal",
    description: "minimal Python project, no agent framework",
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
    description: "Strands agent with AgentCore Memory, Bedrock or another model provider",
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
    description:
      "Strands agent with AgentCore Memory, Bedrock or another model provider, container-based deployment",
    build: "Container",
    language: "Python",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
  },
  "agent-typescript-strands": {
    runtimeName: "agent_typescript_strands",
    description:
      "Strands agent in TypeScript with AgentCore Memory, Bedrock or another model provider",
    build: "CodeZip",
    language: "TypeScript",
    framework: "strands",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
    runtimeVersion: "NODE_22",
  },
  "agent-python-langchain": {
    runtimeName: "agent_python_langchain",
    description: "LangChain agent with Bedrock for inference",
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
    description: "Vercel AI SDK agent in TypeScript, Bedrock for inference",
    build: "CodeZip",
    language: "TypeScript",
    framework: "vercelai",
    modelProvider: "Bedrock",
    includesMemory: false,
    supportsModelProviderOverride: false,
    runtimeVersion: "NODE_22",
  },
  [BMA_TEMPLATE_NAME]: {
    runtimeName: "environment_python_bma",
    description: "Execution environment for Bedrock Managed Agents",
    build: "Container",
    language: "Python",
    framework: "bma",
    protocol: "HTTP",
    includesMemory: false,
    supportsModelProviderOverride: false,
    profile: BMA_TEMPLATE_PROFILE,
  },
  "mcp-python-fastmcp": {
    runtimeName: "mcp_python_fastmcp",
    description: "MCP server exposing tools with FastMCP",
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
    description: "Strands agent speaking the A2A protocol, Bedrock or another model provider",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    protocol: "A2A",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
    runtimeVersion: "PYTHON_3_14",
  },
  "agui-python-strands": {
    runtimeName: "agui_python_strands",
    description: "Strands agent speaking AG-UI, Bedrock or another model provider",
    build: "CodeZip",
    language: "Python",
    framework: "strands",
    protocol: "AGUI",
    modelProvider: "Bedrock",
    includesMemory: true,
    supportsModelProviderOverride: true,
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
  bma: 3,
  none: 4,
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
const EMPTY_TEMPLATE_DESCRIPTION = "empty project with no Runtime or harness";

export type TemplateName = RuntimeTemplateShortcutName | typeof EMPTY_TEMPLATE_NAME;

/** Every `--template` value: the runtime shortcuts plus the empty project template. */
export const PROJECT_TEMPLATE_NAMES = [
  ...RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  EMPTY_TEMPLATE_NAME,
] as unknown as readonly [TemplateName, ...TemplateName[]];

/**
 * Long-form `--template` help generated from the same registry used to resolve
 * templates and populate the TUI. Project creation also offers the empty
 * project template; adding a Runtime does not.
 */
export function formatTemplateParameterHelp(options?: { includeEmpty?: boolean }): string {
  const names: readonly TemplateName[] = options?.includeEmpty
    ? PROJECT_TEMPLATE_NAMES
    : RUNTIME_TEMPLATE_SHORTCUT_NAMES;
  const descriptions = names.map((name) => ({
    name,
    description:
      name === EMPTY_TEMPLATE_NAME
        ? EMPTY_TEMPLATE_DESCRIPTION
        : RUNTIME_TEMPLATE_SHORTCUTS[name].description,
  }));
  const nameWidth = Math.max(...descriptions.map(({ name }) => name.length));

  return [
    "(template name)",
    "Available templates:",
    ...descriptions.map(({ name, description }) => `  ${name.padEnd(nameWidth + 2)}${description}`),
  ].join("\n");
}

type RuntimeTemplateOverrides = {
  runtimeName?: string;
  modelProvider?: ModelProvider;
  modelId?: string;
  apiKey?: string;
  apiBase?: string;
};

export function resolveRuntimeTemplateShortcut(
  name: RuntimeTemplateShortcutName,
  overrides?: RuntimeTemplateOverrides,
): ScaffoldRuntimeInput {
  const template: RuntimeTemplateShortcut = RUNTIME_TEMPLATE_SHORTCUTS[name];
  const runtimeName = overrides?.runtimeName ?? template.runtimeName;

  const modelProvider = template.supportsModelProviderOverride
    ? (overrides?.modelProvider ?? template.modelProvider)
    : template.modelProvider;

  const input = {
    runtimeName,
    build: template.build,
    language: template.language,
    framework: template.framework,
    protocol: template.protocol,
    modelProvider,
    ...(overrides?.modelId !== undefined && { modelId: overrides.modelId }),
    ...(overrides?.apiKey !== undefined && { apiKey: overrides.apiKey }),
    ...(overrides?.apiBase !== undefined && { apiBase: overrides.apiBase }),
    ...(template.includesMemory && { memory: getDefaultMemorySpec(runtimeName) }),
    runtimeVersion: template.runtimeVersion,
    templateProfile: template.supportsModelProviderOverride
      ? { ...template.profile, modelProviderOverride: true }
      : template.profile,
  };

  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
