import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

export class McpRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'standalone', TEMPLATE_ROOT, 'mcp');
  }

  protected override shouldRenderMemory(): boolean {
    return false;
  }
}
