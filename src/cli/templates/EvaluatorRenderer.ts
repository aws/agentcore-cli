import { copyAndRenderDir } from './render';
import { getTemplatePath } from './templateRoot';

/**
 * Renders a code-based evaluator template to the specified output directory.
 * @param evaluatorName - Name of the evaluator (used for {{ Name }} substitution)
 * @param outputDir - Target directory for the evaluator code
 */
export async function renderCodeBasedEvaluatorTemplate(evaluatorName: string, outputDir: string): Promise<void> {
  const templateDir = getTemplatePath('evaluators', 'python-lambda');
  await copyAndRenderDir(templateDir, outputDir, { Name: evaluatorName });
}

export interface ThirdPartyEvaluatorTemplateData {
  Name: string;
  EvaluatorClass: string;
  EvaluatorParams: string;
  /** True when the LLM judge runs on Bedrock instead of the library's default (OpenAI). */
  ModelProviderBedrock?: boolean;
  /** Bedrock model ID (required when ModelProviderBedrock is true). */
  Model?: string;
}

export async function renderThirdPartyEvaluatorTemplate(
  templateDirName: string,
  data: ThirdPartyEvaluatorTemplateData,
  outputDir: string
): Promise<void> {
  const templateDir = getTemplatePath('evaluators', templateDirName);
  await copyAndRenderDir(templateDir, outputDir, data);
}
