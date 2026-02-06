import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class OpenAIAgentsRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'openaiagents', TEMPLATE_ROOT);
  }
}
