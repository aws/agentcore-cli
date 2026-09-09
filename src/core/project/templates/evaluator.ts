import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { Evaluator } from "../../../projectSchemas/evaluator";
import type { TemplateRenderer, TemplateResolver } from "./types";
import { toPythonPackageName } from "../fsUtils";
import type { ManagedEvaluatorScaffoldInput } from "../../../handlers/project/types";

const DEFAULT_TIMEOUT = 60;
const ASSET_DIR = "evaluators/python-lambda";

function buildManagedEvaluatorSpec(input: ManagedEvaluatorScaffoldInput): Evaluator {
  return {
    name: input.name,
    level: input.level,
    ...(input.description && { description: input.description }),
    config: {
      codeBased: {
        managed: {
          codeLocation: `app/${input.name}`,
          entrypoint: "lambda_function.handler",
          timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT,
          additionalPolicies: ["execution-role-policy.json"],
        },
      },
    },
    ...(input.kmsKeyArn && { kmsKeyArn: input.kmsKeyArn }),
    ...(input.tags && { tags: input.tags }),
  };
}

function buildRenderContext(input: ManagedEvaluatorScaffoldInput): Record<string, unknown> {
  return { Name: toPythonPackageName(input.name) };
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
      const tree = await FsTreeNode.fromAssetSource(
        { assetSource: config.assetSource },
        { assetDir: ASSET_DIR },
        {
          rootDirName: input.name,
          transformContent: (raw) => config.templateRenderer.render(raw, buildRenderContext(input)),
        },
      );
      return { tree, spec: { evaluators: [buildManagedEvaluatorSpec(input)] } };
    },
  };
}
