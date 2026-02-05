import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class AutoGenRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'autogen', TEMPLATE_ROOT);
  }
}
