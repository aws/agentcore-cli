import { APP_DIR } from '../../lib';
import { copyAndRenderDir } from './render';
import type { AgentRenderConfig } from './types';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface RendererContext {
  outputDir: string;
}

type TemplateData = AgentRenderConfig &
  RendererContext & {
    projectName: string;
    Name: string;
    hasMcp: boolean;
  };

export abstract class BaseRenderer {
  protected readonly config: AgentRenderConfig;
  protected readonly sdkName: string;
  protected readonly baseTemplateDir: string;

  protected constructor(config: AgentRenderConfig, sdkName: string, baseTemplateDir: string) {
    this.config = config;
    this.sdkName = sdkName;
    this.baseTemplateDir = baseTemplateDir;
  }

  protected getTemplateDir(): string {
    const language = this.config.targetLanguage.toLowerCase();
    return path.join(this.baseTemplateDir, language, this.sdkName);
  }

  async render(context: RendererContext): Promise<void> {
    const templateDir = this.getTemplateDir();
    const projectName = this.config.name;
    // Agents are placed in app/<agentName>/ directory
    const projectDir = path.join(context.outputDir, APP_DIR, projectName);

    const templateData: TemplateData = {
      ...this.config,
      ...context,
      projectName,
      Name: projectName,
      hasMcp: false, // MCP is configured separately
    };

    // Always render base template
    const baseDir = path.join(templateDir, 'base');
    await copyAndRenderDir(baseDir, projectDir, templateData);

    // Render capability templates based on config
    // Only render if the capability directory exists (not all SDKs have all capabilities)
    if (this.config.hasMemory) {
      const memoryCapabilityDir = path.join(templateDir, 'capabilities', 'memory');
      if (existsSync(memoryCapabilityDir)) {
        const memoryTargetDir = path.join(projectDir, 'memory');
        await copyAndRenderDir(memoryCapabilityDir, memoryTargetDir, templateData);
      }
    }

    // Generate Dockerfile and .dockerignore for Container builds
    if (this.config.buildType === 'Container') {
      const language = this.config.targetLanguage.toLowerCase();
      const containerTemplateDir = path.join(this.baseTemplateDir, 'container', language);

      if (existsSync(containerTemplateDir)) {
        await copyAndRenderDir(containerTemplateDir, projectDir, { ...templateData, entrypoint: 'main' });
      }
    }
  }
}
