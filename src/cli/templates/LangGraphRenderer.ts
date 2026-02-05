import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class LangGraphRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'langchain_langgraph', TEMPLATE_ROOT);
  }
}
