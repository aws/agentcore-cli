import z from "zod";
import { createHandler, flag } from "../../../router";
import { SourceResolver, type AppIO } from "../../../io";
import { runWithProgress } from "../../../tui/progress";
import {
  LANGUAGE_VERSION_DEFAULTS,
  MEMORY_SHORTCUT_NAMES,
  MEMORY_SHORTCUTS,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  resolveRuntimeTemplateShortcut,
} from "../shortcuts";
import {
  ScaffoldRuntimeInputSchema,
  type CreateProjectInput,
  type ProjectManager,
  type ScaffoldHarnessInput,
  type ScaffoldRuntimeInput,
} from "../types";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import {
  CONTAINER_URI_PATTERN,
  HarnessModelProviderSchema,
  HarnessSpecSchema,
  type HarnessModelProvider,
} from "../../../projectSchemas/harness";
import { InputValidationError } from "../../../errors";
import { parseJsonFlag } from "../../utils";
import { DEFAULT_HARNESS_MODEL } from "../add/harness";
import type { CoreBedrockAgentImporter } from "../../../core/project/bedrockAgentImport";
import { importScaffoldRuntimeInput, resolveImportBedrockAgentInput } from "../importBedrockAgent";
import type { ImportBedrockAgentInput } from "../add/runtime/types";
import { JsonKey, RegionKey } from "../../keys";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
  bedrockAgentImporter: CoreBedrockAgentImporter;
};

// Flags that select the runtime-scaffolding path. Any of these (or --template)
// present routes create away from the default harness path, mirroring the
// original CLI's agent-path dispatch.
const RUNTIME_PATH_FLAGS = [
  "build",
  "language",
  "framework",
  "protocol",
  "api-key",
  "runtime-name",
  "memory",
  "type",
  "agent-id",
  "agent-alias-id",
] as const;

// Flags that only make sense for the harness path.
const HARNESS_ONLY_FLAGS = [
  "model-id",
  "api-key-arn",
  "api-base",
  "additional-params",
  "max-iterations",
  "max-tokens",
  "timeout",
  "truncation-strategy",
  "container",
] as const;

const ModelProviderFlagSchema = z.union([z.literal("Bedrock"), HarnessModelProviderSchema]);
type ModelProviderFlag = z.infer<typeof ModelProviderFlagSchema>;

const HARNESS_DEFAULT_MODEL_IDS: Record<HarnessModelProvider, string> = {
  bedrock: DEFAULT_HARNESS_MODEL.modelId,
  open_ai: "gpt-5",
  gemini: "gemini-2.5-flash",
  lite_llm: "anthropic/claude-sonnet-4-5",
};

export const createCreateProjectHandler = (config: CreateProjectHandlerConfig) =>
  createHandler({
    name: "create",
    description: "create a new AgentCore project",
    flags: [
      // Optional at the flag layer (and enforced in handle) so a bare
      // interactive `project create` reaches the TUI wizard middleware instead
      // of dying on Commander's mandatory-option check.
      flag("name", "name of the project to create", ProjectNameSchema.optional()),
      flag(
        "defaults",
        "create a harness project with default settings (this is the default)",
        z.boolean().default(false),
      ),
      flag(
        "template",
        "a preset of flags for scaffolding the runtime; compatible flags override preset values",
        z.enum(RUNTIME_TEMPLATE_SHORTCUT_NAMES).optional(),
      ),
      flag(
        "build",
        "build type for the scaffolded runtime code",
        z.enum(["CodeZip", "Container"]).optional(),
      ),
      flag(
        "language",
        "target language for the scaffolded runtime code",
        z.enum(["Python", "TypeScript"]).optional(),
      ),
      flag(
        "framework",
        "agent framework: strands or none for create; strands or langgraph for import",
        z.enum(["strands", "langgraph", "none"]).optional(),
      ),
      flag(
        "protocol",
        "server protocol: HTTP, MCP, or A2A",
        z.enum(["HTTP", "MCP", "A2A"]).optional(),
      ),
      flag(
        "model-provider",
        "model provider: bedrock, open_ai, gemini, or lite_llm for harnesses; Bedrock for runtime code",
        ModelProviderFlagSchema.optional(),
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "memory",
        "memory option for the scaffolded runtime",
        z.enum(MEMORY_SHORTCUT_NAMES).optional(),
      ),
      flag("runtime-name", "name of the scaffolded runtime", z.string().max(42).optional()),
      flag(
        "type",
        "create scaffolds new agent code (the default); import translates a Bedrock Agent version",
        z.enum(["create", "import"]).optional(),
      ),
      flag(
        "agent-id",
        "Bedrock Agent ID to import (requires --type import)",
        z.string().optional(),
      ),
      flag(
        "agent-alias-id",
        "Bedrock Agent Alias ID selecting the version to import; must point at a prepared " +
          "version, not DRAFT (requires --type import)",
        z.string().optional(),
      ),
      flag("model-id", "model ID for the created harness", z.string().optional()),
      flag(
        "api-key-arn",
        "API key credential ARN for the created harness's model provider",
        z.string().optional(),
      ),
      flag(
        "api-base",
        "base URL for the harness model provider API endpoint (lite_llm)",
        z.string().optional(),
      ),
      flag(
        "additional-params",
        "provider-specific harness model params as a JSON object (lite_llm)",
        z.string().optional(),
      ),
      flag(
        "harness-memory",
        "disable memory for the created harness (this is the default)",
        z.boolean().default(true),
      ),
      flag(
        "max-iterations",
        "max agent loop iterations per invocation (harness)",
        z.number().optional(),
      ),
      flag("max-tokens", "max total output tokens per invocation (harness)", z.number().optional()),
      flag("timeout", "max duration in seconds per invocation (harness)", z.number().optional()),
      flag(
        "truncation-strategy",
        "context truncation strategy for the harness",
        z.enum(["sliding_window", "summarization"]).optional(),
      ),
      flag(
        "container",
        "container image URI or Dockerfile path for the harness",
        z.string().optional(),
      ),
      flag(
        "skip-install",
        "skip installing dependencies (npm install, uv sync)",
        z.boolean().default(false),
      ),
      flag("skip-git", "skip initializing a git repository", z.boolean().default(false)),
    ],
    handle: async (ctx, flags) => {
      const name = flags["name"];
      if (name === undefined) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const presentRuntimeFlags: string[] = RUNTIME_PATH_FLAGS.filter(
        (f) => flags[f] !== undefined,
      );
      const isTemplate = flags["template"] !== undefined;
      if (isTemplate) presentRuntimeFlags.unshift("template");

      const presentHarnessFlags: string[] = HARNESS_ONLY_FLAGS.filter(
        (f) => flags[f] !== undefined,
      );
      if (flags["harness-memory"] === false) presentHarnessFlags.push("no-harness-memory");

      // Mirrors the original CLI's dispatch: mixing the two paths is an error,
      // while --defaults on the runtime path is simply ignored.
      if (presentRuntimeFlags.length > 0 && presentHarnessFlags.length > 0) {
        throw new InputValidationError(
          `Cannot mix runtime scaffolding flags (${formatFlagList(presentRuntimeFlags)}) ` +
            `with harness-only flags (${formatFlagList(presentHarnessFlags)}). ` +
            `A project is created around either a harness (the default) or scaffolded runtime code.`,
        );
      }

      const lockedFlag = (["language", "framework", "protocol"] as const).find(
        (flagName) => flags[flagName] !== undefined,
      );
      if (isTemplate && lockedFlag) {
        throw new InputValidationError(`--${lockedFlag} cannot override a template`);
      }

      const isImport = flags["type"] === "import";
      const scaffoldingChoiceFlags =
        // --framework and --memory are import inputs, not scaffolding choices, so they are
        // validated below instead of rejected here.
        (["build", "language", "model-provider", "api-key"] as const).filter(
          (f) => flags[f] !== undefined,
        );
      if (isImport && (isTemplate || scaffoldingChoiceFlags.length > 0)) {
        const offending = isTemplate ? "template" : scaffoldingChoiceFlags[0];
        throw new InputValidationError(
          `--type import translates a Bedrock Agent into Python CodeZip runtime code; ` +
            `--${offending} cannot be combined with it`,
        );
      }
      if (!isImport && (flags["agent-id"] !== undefined || flags["agent-alias-id"] !== undefined)) {
        throw new InputValidationError("--agent-id and --agent-alias-id require --type import");
      }
      if (isImport && flags["framework"] === "none") {
        throw new InputValidationError("--type import supports --framework strands or langgraph");
      }
      if (!isImport && flags["framework"] === "langgraph") {
        throw new InputValidationError("--framework langgraph requires --type import");
      }
      if (isImport && flags["protocol"] !== undefined && flags["protocol"] !== "HTTP") {
        throw new InputValidationError("an imported Bedrock Agent only supports HTTP");
      }

      const isRuntimePath = presentRuntimeFlags.length > 0;

      let importBedrockAgent: ImportBedrockAgentInput | undefined;
      const runtimeName = flags["runtime-name"] ?? name;
      const importMemory = flags["memory"] ?? "none";
      if (isImport) {
        importBedrockAgent = await resolveImportBedrockAgentInput({
          importer: config.bedrockAgentImporter,
          runtimeName,
          region: ctx.require(RegionKey),
          agentId: flags["agent-id"],
          agentAliasId: flags["agent-alias-id"],
          framework: flags["framework"] === "langgraph" ? "langgraph" : "strands",
          memory: importMemory,
        });
        if (importBedrockAgent.notes.length > 0) {
          config.io.stderr.write(
            `Import generated ${importBedrockAgent.notes.length} manual follow-up ` +
              `${importBedrockAgent.notes.length === 1 ? "item" : "items"} in ` +
              `app/${runtimeName}/IMPORT_NOTES.md.\n`,
          );
        }
      }

      const createInput: CreateProjectInput = isRuntimePath
        ? {
            name,
            skipInstall: flags["skip-install"],
            skipGit: flags["skip-git"],
            scaffoldRuntimeInput: isImport
              ? importScaffoldRuntimeInput(runtimeName, MEMORY_SHORTCUTS[importMemory](runtimeName))
              : await resolveScaffoldRuntimeInput(config, { ...flags, name }),
            importBedrockAgent,
          }
        : {
            name,
            skipInstall: flags["skip-install"],
            skipGit: flags["skip-git"],
            scaffoldHarnessInput: resolveScaffoldHarnessInput({ ...flags, name }),
          };

      if (!isRuntimePath && !flags["defaults"] && presentHarnessFlags.length === 0) {
        config.io.stderr.write(
          "Creating a harness project (pass --framework or --template to scaffold agent code instead).\n",
        );
      }

      // Same driver as build and deploy: a live step list in a TTY, and the previous plain
      // line-per-step output when stderr is not a TTY or --json wants no ANSI on it.
      await runWithProgress(config.projectManager.create(createInput), {
        io: config.io,
        interactive: ctx.require(JsonKey) ? false : undefined,
      });

      config.io.stderr.write(`Created project '${name}' in ./${name}\n`);
      config.io.stderr.write(`To deploy it: cd ${name} && agentcore project deploy\n`);
    },
  });

type RuntimePathFlagValues = {
  name: string;
  template?: (typeof RUNTIME_TEMPLATE_SHORTCUT_NAMES)[number];
  build?: "CodeZip" | "Container";
  language?: "Python" | "TypeScript";
  framework?: "strands" | "langgraph" | "none";
  protocol?: "HTTP" | "MCP" | "A2A";
  "model-provider"?: ModelProviderFlag;
  "api-key"?: string;
  memory?: (typeof MEMORY_SHORTCUT_NAMES)[number];
  "runtime-name"?: string;
};

type HarnessPathFlagValues = {
  name: string;
  "model-provider"?: ModelProviderFlag;
  "model-id"?: string;
  "api-key-arn"?: string;
  "api-base"?: string;
  "additional-params"?: string;
  "max-iterations"?: number;
  "max-tokens"?: number;
  timeout?: number;
  "truncation-strategy"?: "sliding_window" | "summarization";
  container?: string;
};

async function resolveScaffoldRuntimeInput(
  config: CreateProjectHandlerConfig,
  flags: RuntimePathFlagValues,
): Promise<ScaffoldRuntimeInput> {
  const modelProvider = resolveRuntimeModelProvider(flags["model-provider"]);
  const source = new SourceResolver({ stdin: config.io.stdin });
  const apiKey = await source.resolveSecret("api-key", flags["api-key"]);

  const runtimeName = flags["runtime-name"] ?? flags["name"];
  const defaultMemory = flags["framework"] === "strands" ? "longAndShortTerm" : "none";

  return flags["template"] !== undefined
    ? resolveRuntimeTemplateShortcut(flags["template"], {
        runtimeName: flags["runtime-name"],
        build: flags["build"],
        modelProvider,
        apiKey,
        memory: flags["memory"],
      })
    : parseScaffoldRuntimeInput({
        runtimeName,
        build: flags["build"],
        language: flags["language"],
        framework: flags["framework"] === "langgraph" ? undefined : flags["framework"],
        protocol: flags["protocol"],
        modelProvider,
        apiKey,
        memory: MEMORY_SHORTCUTS[flags["memory"] ?? defaultMemory](runtimeName),
        runtimeVersion:
          flags["build"] === "CodeZip"
            ? LANGUAGE_VERSION_DEFAULTS[flags["language"] ?? "Python"]
            : undefined,
      });
}

// The harness input validates against the same schema `project add harness`
// uses, before any file is written; the manager then scaffolds it through the
// same addResource path. Exported so the TUI create wizard builds its harness
// input through the exact same translation as the flag-driven path.
export function resolveScaffoldHarnessInput(flags: HarnessPathFlagValues): ScaffoldHarnessInput {
  const provider = resolveHarnessModelProvider(flags["model-provider"]);
  const additionalParams = parseJsonFlag<Record<string, unknown>>(
    "additional-params",
    flags["additional-params"],
  );

  const input: ScaffoldHarnessInput = {
    // A project name always satisfies the harness name grammar (letters and
    // digits only), so the harness is named after the project like the
    // original CLI does.
    name: flags["name"],
    model: {
      provider,
      modelId: flags["model-id"] ?? HARNESS_DEFAULT_MODEL_IDS[provider],
      apiKeyArn: flags["api-key-arn"],
      apiBase: flags["api-base"],
      additionalParams,
    },
    maxIterations: flags["max-iterations"],
    maxTokens: flags["max-tokens"],
    timeoutSeconds: flags["timeout"],
    truncation: flags["truncation-strategy"]
      ? { strategy: flags["truncation-strategy"] }
      : undefined,
    // Harness memory is opt-in and disabled by default; --no-harness-memory
    // documents the default explicitly.
    ...parseContainerFlag(flags["container"]),
  };

  const result = HarnessSpecSchema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return input;
}

function resolveHarnessModelProvider(value: ModelProviderFlag | undefined): HarnessModelProvider {
  return value === undefined || value === "Bedrock" ? "bedrock" : value;
}

function resolveRuntimeModelProvider(
  value: ModelProviderFlag | undefined,
): ScaffoldRuntimeInput["modelProvider"] | undefined {
  if (value === undefined) return undefined;
  if (value === "Bedrock" || value === "bedrock") return "Bedrock";
  throw new InputValidationError(
    `runtime scaffolding only supports the Bedrock model provider; received '${value}'`,
  );
}

/** A --container value is either an ECR image URI or a local Dockerfile path. */
function parseContainerFlag(
  value: string | undefined,
): Pick<ScaffoldHarnessInput, "containerUri" | "dockerfile"> {
  if (value === undefined) return {};
  return CONTAINER_URI_PATTERN.test(value) ? { containerUri: value } : { dockerfile: value };
}

function formatFlagList(flagNames: string[]): string {
  return flagNames.map((name) => `--${name}`).join(", ");
}

function parseScaffoldRuntimeInput(input: Partial<ScaffoldRuntimeInput>) {
  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
