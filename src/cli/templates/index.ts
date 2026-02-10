import type { BaseRenderer } from './BaseRenderer';
import { CrewAIRenderer } from './CrewAIRenderer';
import { GoogleADKRenderer } from './GoogleADKRenderer';
import { LangGraphRenderer } from './LangGraphRenderer';
import { OpenAIAgentsRenderer } from './OpenAIAgentsRenderer';
import { StrandsRenderer } from './StrandsRenderer';
import type { AgentRenderConfig } from './types';

export { BaseRenderer, type RendererContext } from './BaseRenderer';
export { CDKRenderer, type CDKRendererContext } from './CDKRenderer';
export { renderMcpToolTemplate } from './McpToolRenderer';
export { CrewAIRenderer } from './CrewAIRenderer';
export { GoogleADKRenderer } from './GoogleADKRenderer';
export { LangGraphRenderer } from './LangGraphRenderer';
export { OpenAIAgentsRenderer } from './OpenAIAgentsRenderer';
export { StrandsRenderer } from './StrandsRenderer';
export type { AgentRenderConfig } from './types';

/**
 * Factory function to create the appropriate renderer based on config
 */
export function createRenderer(config: AgentRenderConfig): BaseRenderer {
  switch (config.sdkFramework) {
    case 'Strands':
      return new StrandsRenderer(config);
    case 'CrewAI':
      return new CrewAIRenderer(config);
    case 'GoogleADK':
      return new GoogleADKRenderer(config);
    case 'LangChain_LangGraph':
      return new LangGraphRenderer(config);
    case 'OpenAIAgents':
      return new OpenAIAgentsRenderer(config);
    default: {
      const _exhaustive: never = config.sdkFramework;
      throw new Error(`Unsupported SDK framework: ${String(_exhaustive)}`);
    }
  }
}
