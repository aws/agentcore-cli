import type { BaseRenderer } from './BaseRenderer';
import { GoogleADKRenderer } from './GoogleADKRenderer';
import { LangGraphRenderer } from './LangGraphRenderer';
import { McpRenderer } from './McpRenderer';
import { OpenAIAgentsRenderer } from './OpenAIAgentsRenderer';
import { StrandsRenderer } from './StrandsRenderer';
import { VercelAIRenderer } from './VercelAIRenderer';
import type { AgentRenderConfig } from './types';

export { BaseRenderer, type RendererContext } from './BaseRenderer';
export { CDKRenderer, type CDKRendererContext } from './CDKRenderer';
export { renderGatewayTargetTemplate } from './GatewayTargetRenderer';
export { GoogleADKRenderer } from './GoogleADKRenderer';
export { LangGraphRenderer } from './LangGraphRenderer';
export { McpRenderer } from './McpRenderer';
export { OpenAIAgentsRenderer } from './OpenAIAgentsRenderer';
export { StrandsRenderer } from './StrandsRenderer';
export { VercelAIRenderer } from './VercelAIRenderer';
export type { AgentRenderConfig } from './types';

/**
 * Factory function to create the appropriate renderer based on config
 */
export function createRenderer(config: AgentRenderConfig): BaseRenderer {
  // MCP protocol uses a standalone renderer regardless of sdkFramework
  if (config.protocol === 'MCP') {
    return new McpRenderer(config);
  }

  switch (config.sdkFramework) {
    case 'Strands':
      return new StrandsRenderer(config);
    case 'GoogleADK':
      return new GoogleADKRenderer(config);
    case 'LangChain_LangGraph':
      return new LangGraphRenderer(config);
    case 'OpenAIAgents':
      return new OpenAIAgentsRenderer(config);
    case 'VercelAI':
      return new VercelAIRenderer(config);
    default: {
      const _exhaustive: never = config.sdkFramework;
      throw new Error(`Unsupported SDK framework: ${String(_exhaustive)}`);
    }
  }
}
