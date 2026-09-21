import { existsSync } from "node:fs";
import { stringify } from "yaml";
import { ZodError, z } from "zod";
import { HarnessSpecSchema, type HarnessSpec } from "../../../projectSchemas/harness";
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
  "containerUri",
  "environmentVariables",
  "executionRoleArn",
  "tags",
]);

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
  const yaml = Object.fromEntries(
    Object.entries(spec)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        // Quoted multiline values cannot absorb the template's section-separating blank lines.
        stringify({ [key]: value }, { blockQuote: false }).slice(0, -1),
      ]),
  );
  return {
    ...spec,
    yaml,
    modelMaxTokensExample: !("maxTokens" in spec.model),
    memoryExamples: Object.fromEntries(
      ["strategies", "eventExpiryDuration", "name", "arn"].map((key) => [
        key,
        !(key in (spec.memory ?? {})),
      ]),
    ),
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
