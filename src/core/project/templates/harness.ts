import { existsSync } from "node:fs";
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
};

/** Given a harness spec, resolve the {@link TemplateResolver} that renders its config directory **/
export function getHarnessTemplateResolver(
  config: GetHarnessTemplateResolverConfig,
): TemplateResolver<z.input<typeof HarnessSpecSchema>> {
  return {
    async resolve(spec) {
      validateHarnessTemplateSource(spec);

      const parsed = parseHarnessSpec({
        ...spec,
        memory: spec.memory === undefined ? { mode: "managed" } : spec.memory,
        dockerfile: spec.dockerfile ? "Dockerfile" : undefined,
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
        ...(spec.dockerfile ? [FsTreeNode.fromTextFile("Dockerfile", spec.dockerfile)] : []),
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

export function validateHarnessTemplateSource(spec: z.input<typeof HarnessSpecSchema>): void {
  if (spec.dockerfile && !existsSync(spec.dockerfile)) {
    throw new ResourceNotFoundError(`no dockerfile exists at ${spec.dockerfile}`);
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
