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

    // Update package.json with distro-specific configuration
    logger?.logSubStep('Updating package.json with distro config...');
    await this.updatePackageJson(outputDir);
    logger?.logSubStep('package.json updated');

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

    // Install CDK project dependencies (postinstall script will link agentcore)
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

  private async writeLlmContext(configDir: string): Promise<void> {
    const llmContextDir = path.join(configDir, LLM_CONTEXT_DIR);
    await fs.mkdir(llmContextDir, { recursive: true });

    for (const [filename, content] of Object.entries(LLM_CONTEXT_FILES)) {
      await fs.writeFile(path.join(llmContextDir, filename), content, 'utf-8');
    }
  }

  /**
   * Updates the generated package.json with distro-specific configuration.
   * Adjusts the postinstall script to link the correct package name.
   *
   * If LOCAL_L3_PATH env var is set, uses file: dependency instead of npm link.
   */
  private async updatePackageJson(outputDir: string): Promise<void> {
    const packageJsonPath = path.join(outputDir, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as {
      scripts?: { postinstall?: string };
      dependencies?: Record<string, string>;
      [key: string]: unknown;
    };

    const localL3Path = process.env.LOCAL_L3_PATH;

    if (localL3Path) {
      // Use local file: dependency for development
      if (pkg.dependencies) {
        pkg.dependencies['@aws/agentcore-l3-cdk-constructs'] = `file:${localL3Path}`;
      }
      // Remove postinstall npm link since we're using file: dependency
      if (pkg.scripts?.postinstall) {
        delete pkg.scripts.postinstall;
      }
    } else {
      // Production: use npm link with the L3 constructs package
      // Note: The template already has the correct postinstall script, so we don't need to modify it
      // Just leave it as-is from the template
    }

    await fs.writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  }
}
