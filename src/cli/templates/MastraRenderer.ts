import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class MastraRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'mastra', TEMPLATE_ROOT, config.protocol ?? 'http');
  }
}
