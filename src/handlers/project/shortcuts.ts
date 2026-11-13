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

/**
 * The name of the Box gateway, which the CDK library adds to a project with
 * `"projectType": "box"`. The agentcore.json entry of this name only adds
 * targets to it.
 */
export const BOX_GATEWAY_NAME = "box";

/** The name of the Box gateway's Bedrock model target. */
export const BOX_GATEWAY_BEDROCK_TARGET_NAME = "bedrock";

/**
 * The region of the Box gateway's Bedrock target, fixed for now.
 * `create` does not know the deploy region (deploy resolves it, per target), so
 * a project deployed elsewhere still calls Bedrock in this region until the
 * target is edited in agentcore.json.
 */
export const BOX_GATEWAY_BEDROCK_REGION = "us-west-2";

/**
 * The Box gateway entry that `agentcore create` declares next to
 * `"projectType": "box"`, so the deployed agent's outbound calls go through one
 * gateway. The CDK library owns the gateway itself, and allows the entry only
 * the settings below, which are the Box gateway's own. It gets a passthrough
 * target for the Bedrock model endpoint only when the agent calls Bedrock:
 * another model provider's endpoint takes an API key, which create does not
 * have a credential for.
 */
export function getBoxGatewaySpec(options: { bedrockTarget: boolean }): AgentCoreGateway {
  const region = BOX_GATEWAY_BEDROCK_REGION;
  return {
    name: BOX_GATEWAY_NAME,
    protocolType: "None",
    authorizerType: "AWS_IAM",
    // The only value the Box gateway entry accepts; it has no effect without MCP.
    enableSemanticSearch: true,
    exceptionLevel: "NONE",
    targets: [
      ...(options.bedrockTarget
        ? [
            {
              name: BOX_GATEWAY_BEDROCK_TARGET_NAME,
              targetType: "passthrough" as const,
              passthrough: {
                endpoint: `https://bedrock-runtime.${region}.amazonaws.com`,
                protocolType: "CUSTOM" as const,
              },
              outboundAuth: { type: "GATEWAY_IAM_ROLE" as const, service: "bedrock", region },
            },
          ]
        : []),
    ],
  };
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
  /**
   * Ships with the Box gateway: the project is a Box project, so the agent's
   * outbound calls, including a model added later, have a gateway to go through.
   */
  includesBoxGateway: boolean;
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: false,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    includesBoxGateway: true,
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
    ...(template.includesBoxGateway && {
      boxGateway: getBoxGatewaySpec({
        // A template with no model provider (an MCP server) calls no model yet: no Bedrock target.
        bedrockTarget:
          modelProvider !== undefined &&
          callsBedrockModel({ modelProvider, modelId: overrides?.modelId }),
      }),
    }),
    runtimeVersion: template.runtimeVersion,
    templateProfile: template.supportsModelProviderOverride
      ? { ...template.profile, modelProviderOverride: true }
      : template.profile,
  };

  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
