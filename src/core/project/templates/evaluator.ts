import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { Evaluator } from "../../../projectSchemas/evaluator";
import type { TemplateRenderer, TemplateResolver } from "./types";
import { toPythonPackageName } from "../fsUtils";
import type {
  EvaluatorLibrary,
  ManagedEvaluatorScaffoldInput,
} from "../../../handlers/project/types";

const DEFAULT_TIMEOUT = 60;

const EVALUATOR_ASSETS: Record<
  EvaluatorLibrary,
  { assetDir: string; defaultTimeoutSeconds: number }
> = {
  deepeval: { assetDir: "evaluators/deepeval-lambda", defaultTimeoutSeconds: 300 },
  autoevals: { assetDir: "evaluators/autoevals-lambda", defaultTimeoutSeconds: DEFAULT_TIMEOUT },
};

const EMPTY_ASSET_DIR = "evaluators/python-lambda";

function buildManagedEvaluatorSpec(input: ManagedEvaluatorScaffoldInput): Evaluator {
  const timeoutSeconds =
    input.timeoutSeconds ??
    (input.metric ? EVALUATOR_ASSETS[input.metric.library].defaultTimeoutSeconds : DEFAULT_TIMEOUT);
  return {
    name: input.name,
    level: input.level,
    ...(input.description && { description: input.description }),
    config: {
      codeBased: {
        managed: {
          codeLocation: `app/${input.name}`,
          entrypoint: "lambda_function.handler",
          timeoutSeconds,
          additionalPolicies: ["execution-role-policy.json"],
        },
      },
    },
    ...(input.kmsKeyArn && { kmsKeyArn: input.kmsKeyArn }),
    ...(input.tags && { tags: input.tags }),
  };
}

function buildRenderContext(input: ManagedEvaluatorScaffoldInput): Record<string, unknown> {
  const context: Record<string, unknown> = { Name: toPythonPackageName(input.name) };
  if (input.metric) {
    context["EvaluatorClass"] = input.metric.metricClass;
    context["Model"] = input.model ?? "";
    context["ModelProviderBedrock"] = input.model !== undefined;
    context["EvaluatorParams"] = "";
  }
  return context;
}

type GetEvaluatorTemplateResolverConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};

export function getEvaluatorTemplateResolver(
  config: GetEvaluatorTemplateResolverConfig,
): TemplateResolver<ManagedEvaluatorScaffoldInput> {
  return {
    async resolve(input) {
      const assetDir = input.metric
        ? EVALUATOR_ASSETS[input.metric.library].assetDir
        : EMPTY_ASSET_DIR;
      const tree = await FsTreeNode.fromAssetSource(
        { assetSource: config.assetSource },
        { assetDir },
        {
          rootDirName: input.name,
          transformContent: (raw) => config.templateRenderer.render(raw, buildRenderContext(input)),
        },
      );
      return { tree, spec: { evaluators: [buildManagedEvaluatorSpec(input)] } };
    },
  };
}
