import { CONFIG_DIR, runSubprocessCapture } from '../../lib';
import { CDK_PROJECT_DIR } from '../constants';
import type { CreateLogger } from '../logging';
import { copyDir } from './render';
import { LLM_CONTEXT_FILES } from './schema-assets';
import { getTemplatePath } from './templateRoot';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const LLM_CONTEXT_DIR = '.llm-context';

export interface CDKRendererContext {
  /**
   * The project root directory (e.g., /projects/MyApp).
   * The CDK project will be created at <projectRoot>/agentcore/cdk/
   */
  projectRoot: string;
  /**
   * Optional logger for tracking progress
   */
  logger?: CreateLogger;
}

/**
 * Renders the CDK project template to the specified project.
 * Creates the CDK project at <projectRoot>/agentcore/cdk/.
 *
 * Also writes:
 * - AGENTS.md to <projectRoot>/ for AI coding assistant context
 * - README.md to <projectRoot>/ for project documentation
 * - .llm-context/ directory with LLM-compacted schema files
 */
export class CDKRenderer {
  private readonly templateDir: string;
  private readonly agentsTemplateDir: string;
  private readonly assetsDir: string;

  constructor() {
    this.templateDir = getTemplatePath('cdk');
    this.agentsTemplateDir = getTemplatePath('agents');
    this.assetsDir = getTemplatePath('');
  }

  async render(context: CDKRendererContext): Promise<string> {
    const { logger } = context;
    const configDir = path.join(context.projectRoot, CONFIG_DIR); // agentcore/ directory
    const outputDir = path.join(configDir, CDK_PROJECT_DIR);

    // Copy CDK project template
    logger?.logSubStep('Copying CDK project template...');
    await copyDir(this.templateDir, outputDir);
    logger?.logSubStep('CDK template copied');

    // Copy AGENTS.md template to project root
    logger?.logSubStep('Copying AGENTS.md template...');
    await this.copyAgentsTemplate(context.projectRoot);
    logger?.logSubStep('AGENTS.md copied');

    // Copy README.md template to project root
    logger?.logSubStep('Copying README.md template...');
    await this.copyReadmeTemplate(context.projectRoot);
    logger?.logSubStep('README.md copied');

    // Write LLM context files to agentcore/.llm-context/
    logger?.logSubStep('Writing LLM context files...');
    await this.writeLlmContext(configDir);
    logger?.logSubStep('LLM context files written');

    // Skip slow npm operations in test mode
    if (process.env.AGENTCORE_SKIP_INSTALL) return outputDir;

    // Install CDK project dependencies
    logger?.logSubStep('Running npm install (this may take a while)...');
    logger?.logCommand('npm', ['install']);
    const installStart = Date.now();
    const installResult = await runSubprocessCapture('npm', ['install'], { cwd: outputDir });
    const installDuration = Date.now() - installStart;
    if (installResult.stdout) {
      logger?.logCommandOutput(installResult.stdout);
    }
    if (installResult.stderr) {
      logger?.logCommandOutput(installResult.stderr);
    }
    if (installResult.code !== 0) {
      throw new Error(`npm install failed with code ${installResult.code}: ${installResult.stderr}`);
    }
    logger?.logSubStep(`npm install completed (${(installDuration / 1000).toFixed(1)}s)`);

    // If the CLI was built with a bundled CDK constructs tarball (via npm run bundle),
    // install it to override the registry version. This is a no-op for normal builds.
    await this.installBundledCdkIfPresent(outputDir, logger);

    // Format the CDK project files
    logger?.logSubStep('Running npm run format...');
    logger?.logCommand('npm', ['run', 'format']);
    const formatResult = await runSubprocessCapture('npm', ['run', 'format'], { cwd: outputDir });
    if (formatResult.stdout) {
      logger?.logCommandOutput(formatResult.stdout);
    }
    if (formatResult.stderr) {
      logger?.logCommandOutput(formatResult.stderr);
    }
    if (formatResult.code !== 0) {
      throw new Error(`npm run format failed with code ${formatResult.code}: ${formatResult.stderr}`);
    }
    logger?.logSubStep('Formatting completed');

    return outputDir;
  }

  private async copyAgentsTemplate(projectRoot: string): Promise<void> {
    const agentsMdSrc = path.join(this.agentsTemplateDir, 'AGENTS.md');
    const agentsMdDest = path.join(projectRoot, 'AGENTS.md');
    await fs.copyFile(agentsMdSrc, agentsMdDest);
  }

  private async copyReadmeTemplate(projectRoot: string): Promise<void> {
    const readmeSrc = path.join(this.assetsDir, 'README.md');
    const readmeDest = path.join(projectRoot, 'README.md');
    await fs.copyFile(readmeSrc, readmeDest);
  }

  private async installBundledCdkIfPresent(cdkProjectDir: string, logger?: CreateLogger): Promise<void> {
    const bundledTarball = path.join(this.assetsDir, 'bundled-agentcore-cdk.tgz');

    try {
      await fs.access(bundledTarball);
    } catch {
      // No bundled tarball — normal build, nothing to do
      return;
    }

    // Copy tarball into the CDK project so npm resolves a clean local path
    const localTarball = path.join(cdkProjectDir, 'bundled-agentcore-cdk.tgz');
    await fs.copyFile(bundledTarball, localTarball);

    logger?.logSubStep('Installing bundled @aws/agentcore-cdk override...');
    const result = await runSubprocessCapture('npm', ['install', './bundled-agentcore-cdk.tgz'], {
      cwd: cdkProjectDir,
    });
    if (result.stdout) {
      logger?.logCommandOutput(result.stdout);
    }
    if (result.stderr) {
      logger?.logCommandOutput(result.stderr);
    }
    if (result.code !== 0) {
      throw new Error(`Failed to install bundled @aws/agentcore-cdk: ${result.stderr}`);
    }

    // Keep the tarball in the project so the file: reference in package.json
    // stays valid for future npm install runs.
    logger?.logSubStep('Bundled @aws/agentcore-cdk installed');
  }

  private async writeLlmContext(configDir: string): Promise<void> {
    const llmContextDir = path.join(configDir, LLM_CONTEXT_DIR);
    await fs.mkdir(llmContextDir, { recursive: true });

    for (const [filename, content] of Object.entries(LLM_CONTEXT_FILES)) {
      await fs.writeFile(path.join(llmContextDir, filename), content, 'utf-8');
    }
  }
}
