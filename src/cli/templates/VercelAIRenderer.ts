import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class VercelAIRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'vercelai', TEMPLATE_ROOT, config.protocol ?? 'http');
  }
}
