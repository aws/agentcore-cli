import { createHash } from "node:crypto";
import z from "zod";
import { createHandler, flag, PlatformKey, type Middleware } from "../../../router";
import { assertProjectPathFits } from "./pathLimit";
import { SourceResolver, type AppIO } from "../../../io";
import { runWithProgress } from "../../../tui/progress";
import {
  EMPTY_TEMPLATE_NAME,
  PROJECT_TEMPLATE_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
  formatTemplateParameterHelp,
  resolveRuntimeTemplateShortcut,
} from "../shortcuts";
import {
  type CreateProjectInput,
  type ModelProvider,
  type ProjectManager,
  type ScaffoldHarnessInput,
} from "../types";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import {
  HARNESS_DEFAULT_MODEL_IDS,
  HarnessModelProviderSchema,
  HarnessSpecSchema,
  type HarnessModelProvider,
} from "../../../projectSchemas/harness";
import { InputValidationError } from "../../../errors";
import { JsonKey, RegionKey } from "../../keys";
import { renderResult } from "../../utils";
import { projectReference, type ProjectMutationResult } from "../output";
import { stripCreateRegionUnavailableDefaults, validateCreateRegionSupport } from "./region";
import { MODEL_DOCS_URLS } from "../../../projectSchemas/modelDocs";
import { harnessApiKeyCredentialName } from "../../../core/project/templates/harness";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
  middlewares?: Middleware[];
};

const MODEL_PROVIDER_FLAG_VALUES = [
  ...HarnessModelProviderSchema.options,
  "anthropic",
  "openai_compatible",
] as const;
// `add runtime` parses its provider through ModelProviderSchema, which takes `litellm`/`openai` in
// any case; create accepts the same spellings so a command copied from one works in the other.
const MODEL_PROVIDER_FLAG_ALIASES: Record<string, (typeof MODEL_PROVIDER_FLAG_VALUES)[number]> = {
  litellm: "lite_llm",
  openai: "open_ai",
  "openai-compatible": "openai_compatible",
  openaicompatible: "openai_compatible",
};
const ModelProviderFlagSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const lower = value.toLowerCase();
  return MODEL_PROVIDER_FLAG_ALIASES[lower] ?? lower;
}, z.enum(MODEL_PROVIDER_FLAG_VALUES));
type ModelProviderFlag = z.infer<typeof ModelProviderFlagSchema>;

// Where each --model-provider lists its model IDs. openai_compatible has no
// single list: the IDs are whatever the chosen endpoint serves.
const MODEL_ID_FLAG_HELP = [
  "(model id)",
  "Model IDs by --model-provider:",
  ...(["bedrock", "anthropic", "open_ai", "gemini", "lite_llm"] as const).map(
    (provider) => `  ${provider.padEnd(18)}${MODEL_DOCS_URLS[provider]}`,
  ),
  `  ${"openai_compatible".padEnd(18)}the IDs your endpoint serves`,
].join("\n");

export const DEFAULT_CREATE_RUNTIME_NAME = "agent";

/**
 * The command both entry points suggest after create. A runtime project can be
 * run locally first; `agentcore dev` does not serve harnesses yet, so the rest
 * go straight to deploy.
 */
export function createNextStep(scaffoldsRuntime: boolean): string {
  return scaffoldsRuntime ? "agentcore dev" : "agentcore deploy";
}

export const createCreateProjectHandler = (config: CreateProjectHandlerConfig) =>
  createHandler({
    name: "create",
    description: "create a new project",
    middlewares: config.middlewares,
    flags: [
      flag("name", "name of the project to create", ProjectNameSchema),
      flag(
        "template",
        "the template to scaffold the Runtime from; some templates also accept --model-provider/--api-key",
        z.enum(PROJECT_TEMPLATE_NAMES).optional(),
        { help: formatTemplateParameterHelp({ includeEmpty: true }) },
      ),
      flag(
        "model-provider",
        "model provider for templates that support it: bedrock, anthropic, open_ai (or openai), " +
          "openai_compatible, gemini, or lite_llm (or litellm)",
        ModelProviderFlagSchema.optional(),
      ),
      flag(
        "model-id",
        "model id for the scaffolded Runtime code, overriding the provider's default " +
          "(required with openai_compatible, and with litellm in China regions)",
        z.string().min(1).optional(),
        { help: MODEL_ID_FLAG_HELP },
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers (runtime templates and the default harness): '-' for " +
          "stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "api-base",
        "base URL of the endpoint for --model-provider openai_compatible (required with it, " +
          "not accepted with other providers)",
        z.string().url().optional(),
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
      if (!flags["skip-install"]) {
        assertProjectPathFits(name, ctx.require(PlatformKey), {
          alternative: "pass --skip-install and install the CDK dependencies yourself",
        });
      }

      const template = flags["template"];
      const modelProviderFlag = flags["model-provider"];
      const apiKeyFlag = flags["api-key"];

      // The default harness takes a harness model provider, its model id, and
      // an API key; anything else stays a runtime-template flag.
      const harnessModelFlags =
        template === undefined &&
        (modelProviderFlag === undefined || MODEL_PROVIDERS[modelProviderFlag].harness);
      const runtimeCodeFlags = (
        harnessModelFlags
          ? (["api-base"] as const)
          : (["model-provider", "model-id", "api-key", "api-base"] as const)
      ).filter((flagName) => flags[flagName] !== undefined);
      if (runtimeCodeFlags.length > 0) {
        if (template === undefined || template === EMPTY_TEMPLATE_NAME) {
          throw new InputValidationError(
            `--${runtimeCodeFlags[0]} only applies to runtime templates`,
          );
        }
        if (!RUNTIME_TEMPLATE_SHORTCUTS[template].supportsModelProviderOverride) {
          throw new InputValidationError(
            `--${runtimeCodeFlags[0]} is not valid with the ${template} template`,
          );
        }
      }

      const base = {
        name,
        skipInstall: flags["skip-install"],
        skipGit: flags["skip-git"],
      };

      let createInput: CreateProjectInput;
      if (template === undefined) {
        if (
          apiKeyFlag === undefined &&
          (modelProviderFlag === "open_ai" || modelProviderFlag === "gemini")
        ) {
          throw new InputValidationError(
            `--model-provider ${modelProviderFlag} requires --api-key ('-' for stdin, ` +
              "'file://path' for file)",
          );
        }
        const scaffoldHarnessInput = resolveScaffoldHarnessInput({
          name,
          "model-provider": modelProviderFlag,
          "model-id": flags["model-id"],
          "api-key": apiKeyFlag,
        });
        const source = new SourceResolver({ stdin: config.io.stdin });
        const harnessApiKey = await source.resolveSecret("api-key", apiKeyFlag);
        createInput = { ...base, scaffoldHarnessInput, harnessApiKey };
      } else if (template === EMPTY_TEMPLATE_NAME) {
        createInput = { ...base };
      } else {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const apiKey = await source.resolveSecret("api-key", apiKeyFlag);
        const scaffoldRuntimeInput = resolveRuntimeTemplateShortcut(template, {
          runtimeName: DEFAULT_CREATE_RUNTIME_NAME,
          modelProvider: resolveRuntimeModelProvider(modelProviderFlag),
          modelId: flags["model-id"],
          apiKey,
          apiBase: flags["api-base"],
        });
        createInput = { ...base, scaffoldRuntimeInput };
      }

      const region = ctx.require(RegionKey);
      validateCreateRegionSupport(createInput, region);
      const stripped = stripCreateRegionUnavailableDefaults(createInput, region);
      if (stripped !== undefined) config.io.stderr.write(`${stripped}\n`);

      // Same driver as build and deploy: a live step list in a TTY, and the previous plain
      // line-per-step output when stderr is not a TTY or --json wants no ANSI on it.
      const project = await runWithProgress(config.projectManager.create(createInput), {
        io: config.io,
        interactive: ctx.require(JsonKey) ? false : undefined,
      });

      renderResult<ProjectMutationResult>(
        ctx,
        {
          operation: "create",
          project: projectReference(project),
        },
        () => {
          config.io.stderr.write(`Created project '${name}' in ./${name}\n`);
          config.io.stderr.write(
            `Next steps:\n  cd ${name}\n  ${createNextStep(createInput.scaffoldRuntimeInput !== undefined)}\n`,
          );
        },
      );
    },
  });

type HarnessPathFlagValues = {
  name: string;
  "model-provider"?: ModelProviderFlag;
  "model-id"?: string;
  "api-key-arn"?: string;
  /**
   * Where the managed API key comes from ('-', 'file://path'). Only its presence
   * matters here: the model then names the project credential the key is stored
   * under. The caller reads the key itself and passes it as harnessApiKey.
   */
  "api-key"?: string;
  "api-base"?: string;
};

// The harness input validates against the same schema `agentcore add harness`
// uses, before any file is written; the manager then scaffolds it through the
// same addResource path. Exported so the TUI create wizard builds its harness
// input through the exact same translation as the flag-driven path.
export function resolveScaffoldHarnessInput(flags: HarnessPathFlagValues): ScaffoldHarnessInput {
  const provider = resolveHarnessModelProvider(flags["model-provider"]);
  const name = defaultHarnessNameFor(flags["name"]);
  const managedApiKey = flags["api-key"] !== undefined;
  if (managedApiKey && provider === "bedrock") {
    throw new InputValidationError(
      "--api-key is not supported for the bedrock model provider; Bedrock uses the harness role. " +
        "Pass --model-provider open_ai, gemini, or lite_llm",
    );
  }
  if (managedApiKey && flags["api-key-arn"] !== undefined) {
    throw new InputValidationError(
      "give either an API key or an API key credential provider ARN, not both",
    );
  }

  const input: ScaffoldHarnessInput = {
    name,
    model: {
      provider,
      modelId: flags["model-id"] ?? HARNESS_DEFAULT_MODEL_IDS[provider],
      apiKeyArn: flags["api-key-arn"],
      ...(managedApiKey &&
        provider !== "bedrock" && {
          apiKeyCredentialName: harnessApiKeyCredentialName(name, provider),
        }),
      apiBase: flags["api-base"],
    },
  };

  const result = HarnessSpecSchema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return input;
}

/**
 The deployed `<project>_default_<harness>` must fit CloudFormation's 40-character HarnessName cap, so a project name over 15 characters gets a truncated harness name ending in a 5-character hash.
**/
function defaultHarnessNameFor(projectName: string): string {
  const budget = 40 - `_${DEFAULT_TARGET_NAME}_`.length;
  if (projectName.length * 2 <= budget) return projectName;
  const hash = createHash("sha256").update(projectName).digest("hex").slice(0, 5);
  return `${projectName.slice(0, budget - projectName.length - 6)}_${hash}`;
}

// Runtimes and harnesses support different model sets and record them under
// different names in their spec configs, so the shared --model-provider flag is
// mapped to each domain here behind a consistent interface.
const MODEL_PROVIDERS: Record<
  ModelProviderFlag,
  { harness?: HarnessModelProvider; runtime?: ModelProvider }
> = {
  bedrock: { harness: "bedrock", runtime: "Bedrock" },
  open_ai: { harness: "open_ai", runtime: "OpenAI" },
  gemini: { harness: "gemini", runtime: "Gemini" },
  lite_llm: { harness: "lite_llm", runtime: "LiteLLM" },
  anthropic: { runtime: "Anthropic" },
  openai_compatible: { runtime: "OpenAICompatible" },
};

function resolveHarnessModelProvider(
  providerFlag: ModelProviderFlag | undefined,
): HarnessModelProvider {
  if (providerFlag === undefined) return "bedrock";
  const provider = MODEL_PROVIDERS[providerFlag].harness;
  if (provider === undefined)
    throw new InputValidationError(
      `the '${providerFlag}' model provider is not supported for harness projects`,
    );
  return provider;
}

function resolveRuntimeModelProvider(
  providerFlag: ModelProviderFlag | undefined,
): ModelProvider | undefined {
  return providerFlag === undefined ? undefined : MODEL_PROVIDERS[providerFlag].runtime;
}
