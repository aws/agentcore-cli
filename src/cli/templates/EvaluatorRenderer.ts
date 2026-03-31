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
