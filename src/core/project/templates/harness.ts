import { existsSync } from "node:fs";
import { stringify } from "yaml";
import { ZodError, z } from "zod";
import {
  HARNESS_MODEL_CONFIG_KEYS,
  HarnessSpecSchema,
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
  const {
    model,
    memory,
    skills,
    containerUri,
    networkMode,
    networkConfig,
    lifecycleConfig,
    sessionStoragePath,
    efsAccessPoints,
    s3AccessPoints,
    authorizerType: _authorizerType,
    authorizerConfiguration,
    ...settings
  } = spec;
  const { provider, ...modelConfig } = model;
  const modelKey = HARNESS_MODEL_CONFIG_KEYS[provider];
  const { mode, ...memoryConfig } = memory ?? {};
  const memoryKey =
    mode &&
    {
      managed: "managedMemoryConfiguration",
      existing: "agentCoreMemoryConfiguration",
      disabled: "disabled",
    }[mode];
  const mounts = [
    ...(sessionStoragePath ? [{ sessionStorage: { mountPath: sessionStoragePath } }] : []),
    ...(efsAccessPoints ?? []).map((efsAccessPoint) => ({ efsAccessPoint })),
    ...(s3AccessPoints ?? []).map((s3FilesAccessPoint) => ({ s3FilesAccessPoint })),
  ];
  const runtime = Object.fromEntries(
    Object.entries({
      networkConfiguration: networkMode
        ? {
            networkMode,
            networkModeConfig: networkConfig && {
              subnets: networkConfig.subnets,
              securityGroups: networkConfig.securityGroups,
            },
          }
        : undefined,
      lifecycleConfiguration: lifecycleConfig,
      filesystemConfigurations: mounts.length ? mounts : undefined,
    }).filter(([, value]) => value !== undefined),
  );
  const yaml = Object.fromEntries(
    Object.entries({
      ...settings,
      model: { [modelKey]: modelConfig },
      memory: memoryKey ? { [memoryKey]: memoryConfig } : undefined,
      skills: skills.map((skill) => {
        if ("s3Uri" in skill) return { s3: { uri: skill.s3Uri } };
        if ("gitUrl" in skill) {
          const { gitUrl, ...git } = skill;
          return { git: { url: gitUrl, ...git } };
        }
        return skill;
      }),
      environmentArtifact: containerUri ? { containerConfiguration: { containerUri } } : undefined,
      environment: Object.keys(runtime).length
        ? { agentCoreRuntimeEnvironment: runtime }
        : undefined,
      networkConfig: networkConfig?.vpcId ? { vpcId: networkConfig.vpcId } : undefined,
      authorizerConfiguration: authorizerConfiguration && {
        customJWTAuthorizer: authorizerConfiguration.customJwtAuthorizer,
      },
    })
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
    modelConfig,
    apiFormatExample:
      provider === "bedrock" ? "converse_stream" : provider === "open_ai" ? "responses" : undefined,
    apiKeyExample: provider !== "bedrock" && !model.apiKeyArn,
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
