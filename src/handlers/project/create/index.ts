import z from "zod";
import { createHandler, flag } from "../../../router";
import { SourceResolver, type AppIO } from "../../../io";
import {
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
  ScaffoldRuntimeInputSchema,
  type CreateProjectInput,
  type ProjectManager,
} from "../types";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import { InputValidationError } from "../../../errors";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createCreateProjectHandler = (config: CreateProjectHandlerConfig) =>
  createHandler({
    name: "create",
    description: "create a new AgentCore project",
    flags: [
      flag("name", "name of the project to create", ProjectNameSchema),
      flag(
        "template",
        "a preset of flags to be leveraged in scaffolding the runtime. mutually exclusive with all runtime scaffolding flags",
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
        z.enum(["Python"]).optional(),
      ),
      flag(
        "framework",
        "agent framework for the scaffolded runtime code",
        z.enum(["none"]).optional(),
      ),
      flag(
        "model-provider",
        "model provider for the scaffolded runtime code",
        z.enum(["Bedrock"]).optional(),
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
      ),
      flag("memory", "memory option for the scaffolded runtime", z.enum(["none"]).optional()),
      flag("runtime-name", "name of the scaffolded runtime", z.string().optional()),
      flag(
        "skip-install",
        "skip installing dependencies (npm install, uv sync)",
        z.boolean().default(false),
      ),
      flag("skip-git", "skip initializing a git repository", z.boolean().default(false)),
    ],
    handle: async (_ctx, flags) => {
      const scaffoldingFlags = [
        "build",
        "language",
        "framework",
        "model-provider",
        "api-key",
        "memory",
        "runtime-name",
      ] as const;

      const presentScaffoldingFlags = scaffoldingFlags.filter((f) => flags[f] !== undefined);
      const isTemplate = flags["template"] !== undefined;
      if (presentScaffoldingFlags.length > 0 && isTemplate)
        throw new InputValidationError(
          `--template and --${presentScaffoldingFlags[0]} are mutually exclusive`,
        );

      const isCustom = presentScaffoldingFlags.length > 0;

      const source = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await source.resolveSecret("api-key", flags["api-key"]);

      const scaffoldRuntimeInput = isTemplate
        ? RUNTIME_TEMPLATE_SHORTCUTS[flags["template"]!]
        : isCustom
          ? parseScaffoldRuntimeInput({
              runtimeName: flags["runtime-name"] ?? flags["name"],
              build: flags["build"],
              language: flags["language"],
              framework: flags["framework"],
              modelProvider: flags["model-provider"],
              apiKey,
              memory: flags["memory"],
            })
          : RUNTIME_TEMPLATE_SHORTCUTS["hello-world-python"];

      const createInput: CreateProjectInput = {
        name: flags["name"],
        skipInstall: flags["skip-install"],
        skipGit: flags["skip-git"],
        scaffoldRuntimeInput,
      };

      for await (const event of config.projectManager.create(createInput)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`Created project '${flags["name"]}' in ./${flags["name"]}\n`);
    },
  });

function parseScaffoldRuntimeInput(input: Record<string, unknown>) {
  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
