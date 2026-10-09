import { createHash } from "node:crypto";
import z from "zod";
import { createHandler, flag, PlatformKey, type Middleware } from "../../../router";
import { assertProjectPathFits } from "./pathLimit";
import { type AppIO } from "../../../io";
import { runWithProgress } from "../../../tui/progress";
import {
  EMPTY_TEMPLATE_NAME,
  PROJECT_TEMPLATE_NAMES,
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
import { InputValidationError, RegionUnsupportedFeatureError } from "../../../errors";
import { JsonKey, RegionKey } from "../../keys";
import { renderResult } from "../../utils";
import { projectReference, type ProjectMutationResult } from "../output";
import { stripCreateRegionUnavailableDefaults, validateCreateRegionSupport } from "./region";
import { chinaModelProviderRestriction } from "../../../core/project/manager";
import { isChinaRegion } from "../../../core/partition";
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
type ModelProviderFlag = (typeof MODEL_PROVIDER_FLAG_VALUES)[number];

export const DEFAULT_CREATE_RUNTIME_NAME = "agent";

/**
 * The command both entry points suggest after create. A runtime project can be
 * run locally first; `agentcore dev` does not serve harnesses yet, so the rest
 * go straight to deploy.
 */
export function createNextStep(scaffoldsRuntime: boolean): string {
  return scaffoldsRuntime ? "agentcore dev" : "agentcore deploy";
}

/**
 * The next steps after creating an empty project, shared by the flag path and
 * the wizard: it has nothing to run or deploy yet, so they point at
 * `agentcore add`. Harnesses are left out in China regions, where they are not
 * available.
 */
export function emptyProjectNextSteps(name: string, china: boolean): string[] {
  const steps: [string, string][] = [
    ...(china
      ? []
      : [["agentcore add harness", "add a config-based agent: pick a model, prompt, and tools"]]),
    ["agentcore add runtime", "add a code-based agent from a template"],
    [
      "agentcore add --help",
      "see everything else you can add (memory, gateways, credentials, ...)",
    ],
    ["agentcore deploy", "deploy to AWS once the project has resources"],
  ] as [string, string][];
  const width = Math.max(...steps.map(([command]) => command.length)) + 2;
  return [
    `cd ${name}`,
    ...steps.map(([command, description]) => `${command.padEnd(width)}${description}`),
  ];
}

export const EMPTY_PROJECT_SUMMARY = "It has no agents or other resources yet.";

/** The full message printed after creating an empty project. */
export function emptyProjectCreatedMessage(name: string, china: boolean): string {
  return [
    `Created empty project '${name}' in ./${name}. ${EMPTY_PROJECT_SUMMARY}`,
    "",
    "Next steps:",
    ...emptyProjectNextSteps(name, china).map((step) => `  ${step}`),
    "",
  ].join("\n");
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
        "the template to scaffold the Runtime from",
        z.enum(PROJECT_TEMPLATE_NAMES).default(EMPTY_TEMPLATE_NAME),
        { help: formatTemplateParameterHelp({ includeEmpty: true }) },
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
      const base = {
        name,
        skipInstall: flags["skip-install"],
        skipGit: flags["skip-git"],
      };

      const createInput: CreateProjectInput =
        template === EMPTY_TEMPLATE_NAME
          ? base
          : {
              ...base,
              scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template, {
                runtimeName: DEFAULT_CREATE_RUNTIME_NAME,
              }),
            };

      const region = ctx.require(RegionKey);
      try {
        validateCreateRegionSupport(createInput, region);
      } catch (error) {
        // The shared China messages name the model flags, which create does not take.
        if (
          error instanceof RegionUnsupportedFeatureError &&
          createInput.scaffoldRuntimeInput !== undefined &&
          error.message === chinaModelProviderRestriction(createInput.scaffoldRuntimeInput)
        ) {
          throw new RegionUnsupportedFeatureError(
            `${error.message} 'agentcore create' takes no model flags: create the project with ` +
              "--template empty and pass them to 'agentcore add runtime --template <template>', " +
              "or run 'agentcore create' interactively.",
            { cause: error },
          );
        }
        throw error;
      }
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
          if (template === EMPTY_TEMPLATE_NAME) {
            config.io.stderr.write(emptyProjectCreatedMessage(name, isChinaRegion(region)));
            return;
          }
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
// same addResource path. Exported for the TUI create wizard, the only path that
// scaffolds a harness at create time.
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
