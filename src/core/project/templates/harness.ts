import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { ZodError, z } from "zod";
import {
  encodeHarnessYaml,
  HarnessSpecSchema,
  type HarnessModelProvider,
  type HarnessSpec,
} from "../../../projectSchemas/harness";
import { FsTreeNode } from "./fsTree";
import { InputValidationError, ResourceNotFoundError } from "../../../errors/errors";
import type { TemplateRenderer, TemplateResolver } from "./types";
import type { AssetSource } from "../source";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant";
const TEMPLATE_FIELDS = new Set([
  "name",
  "model",
  "tools",
  "allowedTools",
  "skills",
  "memory",
  "maxIterations",
  "maxTokens",
  "timeoutSeconds",
  "truncation",
  "dockerfile",
  "environmentArtifact",
  "environment",
  "environmentVariables",
  "executionRoleArn",
  "networkConfig",
  "authorizerConfiguration",
  "connections",
  "tags",
]);

/** How a non-Bedrock harness model provider is spelled in the credential it gets an API key from. */
export const HARNESS_API_KEY_PROVIDER_LABELS: Record<
  Exclude<HarnessModelProvider, "bedrock">,
  string
> = {
  open_ai: "OpenAI",
  gemini: "Gemini",
  lite_llm: "LiteLLM",
};

/**
 * The project credential a harness's managed API key is stored under, named the
 * way a runtime's is (`<name><Provider>ApiKey`).
 */
export function harnessApiKeyCredentialName(
  harnessName: string,
  provider: Exclude<HarnessModelProvider, "bedrock">,
): string {
  return `${harnessName}${HARNESS_API_KEY_PROVIDER_LABELS[provider]}ApiKey`;
}

type GetHarnessTemplateResolverConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
  projectRoot?: string;
};

/** Given a harness spec, resolve the {@link TemplateResolver} that renders its config directory **/
export function getHarnessTemplateResolver(
  config: GetHarnessTemplateResolverConfig,
): TemplateResolver<z.input<typeof HarnessSpecSchema>> {
  return {
    async resolve(spec) {
      validateHarnessTemplateSource(spec, config.projectRoot);

      const parsed = parseHarnessSpec({
        ...spec,
        memory: spec.memory === undefined ? { mode: "managed" } : spec.memory,
        dockerfile: spec.dockerfile
          ? spec.buildContextPath
            ? spec.dockerfile
            : "Dockerfile"
          : undefined,
      });
      const { systemPrompt, ...settings } = parsed;
      const context = buildTemplateContext(settings);
      const tree = await FsTreeNode.fromAssetSource(
        { assetSource: config.assetSource },
        { assetDir: "templates/harness" },
        {
          rootDirName: parsed.name,
          transformContent: (raw) => config.templateRenderer.render(raw, context),
        },
      );
      tree.children.push(
        FsTreeNode.createFile(
          "system-prompt.md",
          async () => systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        ),
        // Without a build context the Dockerfile is copied into the harness
        // directory; a Dockerfile-specific ignore file, which Docker reads instead
        // of .dockerignore, goes with it under the copied name.
        ...(spec.dockerfile && !spec.buildContextPath
          ? [
              FsTreeNode.fromTextFile("Dockerfile", spec.dockerfile),
              ...(existsSync(`${spec.dockerfile}.dockerignore`)
                ? [
                    FsTreeNode.fromTextFile(
                      "Dockerfile.dockerignore",
                      `${spec.dockerfile}.dockerignore`,
                    ),
                  ]
                : []),
            ]
          : []),
      );

      return {
        tree,
        spec: {
          harnesses: [{ name: parsed.name, path: `app/${parsed.name}` }],
        },
      };
    },
  };
}

function buildTemplateContext(spec: HarnessSpec) {
  const { model, memory } = spec;
  const { provider, ...modelConfig } = model;
  const { mode, ...memoryConfig } = memory ?? {};
  const yaml = Object.fromEntries(
    Object.entries(encodeHarnessYaml(spec)).map(([key, value]) => [
      key,
      // Quoted multiline values cannot absorb the template's section-separating blank lines.
      stringify({ [key]: value }, { blockQuote: false }).slice(0, -1),
    ]),
  );
  return {
    ...spec,
    yaml,
    modelConfig,
    apiFormatExample:
      provider === "bedrock" ? "converse_stream" : provider === "open_ai" ? "responses" : undefined,
    apiKeyExample: provider !== "bedrock" && !model.apiKeyArn && !model.apiKeyCredentialName,
    modelMaxTokensExample: !("maxTokens" in spec.model),
    managedMemoryEmpty: mode === "managed" && Object.keys(memoryConfig).length === 0,
    additionalSettings: Object.entries(yaml)
      .filter(([key]) => !TEMPLATE_FIELDS.has(key))
      .map(([, value]) => value),
  };
}

export function validateHarnessTemplateSource(
  spec: z.input<typeof HarnessSpecSchema>,
  projectRoot?: string,
): void {
  if (spec.buildContextPath && !projectRoot) {
    throw new InputValidationError("projectRoot is required for a Harness build context override.");
  }
  const dockerfile =
    spec.dockerfile && typeof spec.buildContextPath === "string"
      ? resolve(projectRoot!, spec.buildContextPath, spec.dockerfile)
      : spec.dockerfile;
  if (dockerfile && !existsSync(dockerfile)) {
    throw new ResourceNotFoundError(`no dockerfile exists at ${dockerfile}`);
  }
}

function parseHarnessSpec(spec: z.input<typeof HarnessSpecSchema>) {
  try {
    return HarnessSpecSchema.parse(spec);
  } catch (err) {
    if (err instanceof ZodError) throw new InputValidationError(z.prettifyError(err));
    throw err;
  }
}
