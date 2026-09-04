import { createHash } from "node:crypto";
import z from "zod";
import { createHandler, flag, PlatformKey } from "../../../router";
import { assertProjectPathFits } from "./pathLimit";
import { SourceResolver, type AppIO } from "../../../io";
import { runWithProgress } from "../../../tui/progress";
import {
  EMPTY_TEMPLATE_NAME,
  PROJECT_TEMPLATE_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
  resolveRuntimeTemplateShortcut,
} from "../shortcuts";
import {
  type CreateProjectInput,
  type ModelProvider,
  type ProjectManager,
  type ScaffoldHarnessInput,
} from "../types";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import {
  HarnessModelProviderSchema,
  HarnessSpecSchema,
  type HarnessModelProvider,
} from "../../../projectSchemas/harness";
import { InputValidationError } from "../../../errors";
import { DEFAULT_HARNESS_MODEL } from "../add/harness";
import { JsonKey } from "../../keys";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

const ModelProviderFlagSchema = z.enum([...HarnessModelProviderSchema.options, "anthropic"]);
type ModelProviderFlag = z.infer<typeof ModelProviderFlagSchema>;

export const HARNESS_DEFAULT_MODEL_IDS: Record<HarnessModelProvider, string> = {
  bedrock: DEFAULT_HARNESS_MODEL.modelId,
  open_ai: "gpt-5",
  gemini: "gemini-2.5-flash",
  lite_llm: `bedrock/${DEFAULT_HARNESS_MODEL.modelId}`,
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
        "template",
        "the template to scaffold the Runtime from; some templates also accept --model-provider/--api-key",
        z.enum(PROJECT_TEMPLATE_NAMES).optional(),
      ),
      flag(
        "model-provider",
        "model provider for templates that support it: bedrock, anthropic, open_ai, gemini, or lite_llm",
        ModelProviderFlagSchema.optional(),
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
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
      if (!flags["skip-install"]) {
        assertProjectPathFits(name, ctx.require(PlatformKey), {
          alternative: "pass --skip-install and install the CDK dependencies yourself",
        });
      }

      const template = flags["template"];
      const modelProviderFlag = flags["model-provider"];
      const apiKeyFlag = flags["api-key"];

      const runtimeCodeFlags = (["model-provider", "api-key"] as const).filter(
        (flagName) => flags[flagName] !== undefined,
      );
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
        createInput = { ...base, scaffoldHarnessInput: resolveScaffoldHarnessInput({ name }) };
      } else if (template === EMPTY_TEMPLATE_NAME) {
        createInput = { ...base };
      } else {
        const source = new SourceResolver({ stdin: config.io.stdin });
        const apiKey = await source.resolveSecret("api-key", apiKeyFlag);
        createInput = {
          ...base,
          scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template, {
            modelProvider: resolveRuntimeModelProvider(modelProviderFlag),
            apiKey,
          }),
        };
      }

      // Same driver as build and deploy: a live step list in a TTY, and the previous plain
      // line-per-step output when stderr is not a TTY or --json wants no ANSI on it.
      await runWithProgress(config.projectManager.create(createInput), {
        io: config.io,
        interactive: ctx.require(JsonKey) ? false : undefined,
      });

      config.io.stderr.write(`Created project '${name}' in ./${name}\n`);
      config.io.stderr.write(`Next steps:\n  cd ${name}\n  agentcore project deploy\n`);
    },
  });

type HarnessPathFlagValues = {
  name: string;
  "model-provider"?: ModelProviderFlag;
  "model-id"?: string;
  "api-key-arn"?: string;
  "api-base"?: string;
};

// The harness input validates against the same schema `project add harness`
// uses, before any file is written; the manager then scaffolds it through the
// same addResource path. Exported so the TUI create wizard builds its harness
// input through the exact same translation as the flag-driven path.
export function resolveScaffoldHarnessInput(flags: HarnessPathFlagValues): ScaffoldHarnessInput {
  const provider = resolveHarnessModelProvider(flags["model-provider"]);

  const input: ScaffoldHarnessInput = {
    // CFN's HarnessName is `${projectName}_${harnessName}` capped at 40 chars.
    // Defaulting the harness to the project name doubles the string, so when
    // the doubled form would exceed the CFN cap we truncate the harness half
    // and append a 5-char hash to keep the derived name short and unique.
    name: defaultHarnessNameFor(flags["name"]),
    model: {
      provider,
      modelId: flags["model-id"] ?? HARNESS_DEFAULT_MODEL_IDS[provider],
      apiKeyArn: flags["api-key-arn"],
      apiBase: flags["api-base"],
    },
  };

  const result = HarnessSpecSchema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return input;
}

// CloudFormation limits HarnessName to 40 characters. The synth step joins the
// project name and the harness name with an underscore. The default harness
// name is the project name. If the project name is 19 characters or less, the
// joined name fits. If the project name is longer, this function shortens the
// harness name so that the joined name is 40 characters. The shortened name
// ends with a 5-character hash of the project name.
function defaultHarnessNameFor(projectName: string): string {
  if (projectName.length <= 19) return projectName;
  const hash = createHash("sha256").update(projectName).digest("hex").slice(0, 5);
  const prefixLen = 40 - projectName.length - 1 - 6;
  return `${projectName.slice(0, prefixLen)}_${hash}`;
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
