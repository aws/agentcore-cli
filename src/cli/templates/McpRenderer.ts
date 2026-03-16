import { APP_DIR } from '../../lib';
import { BaseRenderer } from './BaseRenderer';
import type { RendererContext } from './BaseRenderer';
import { copyAndRenderDir } from './render';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export class McpRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'standalone', TEMPLATE_ROOT, 'mcp');
  }

  override async render(context: RendererContext): Promise<void> {
    const templateDir = this.getTemplateDir();
    const projectName = this.config.name;
    const projectDir = path.join(context.outputDir, APP_DIR, projectName);

    const templateData = {
      ...this.config,
      ...context,
      projectName,
      Name: projectName,
      hasMcp: false,
    };

    // Render base template only (MCP has no memory capabilities)
    const baseDir = path.join(templateDir, 'base');
    await copyAndRenderDir(baseDir, projectDir, templateData);

    // Generate Dockerfile for Container builds
    if (this.config.buildType === 'Container') {
      const language = this.config.targetLanguage.toLowerCase();
      const containerTemplateDir = path.join(this.baseTemplateDir, 'container', language);

      if (existsSync(containerTemplateDir)) {
        await copyAndRenderDir(containerTemplateDir, projectDir, { ...templateData, entrypoint: 'main' });
      }
    }
  }
}
