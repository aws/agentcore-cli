import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class CrewAIRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'crewai', TEMPLATE_ROOT);
  }
}
