import type { ToolDefinition } from '../../schema';
import type { ComputeHost, TargetLanguage } from '../tui/screens/mcp/types';
import { copyAndRenderDir } from './render';
import { getTemplatePath } from './templateRoot';

/**
 * Tool definitions for the Lambda template.
 * Each tool has a complete inputSchema for proper gateway integration.
 */
export const LAMBDA_TEMPLATE_TOOLS: ToolDefinition[] = [
  {
    name: 'lookup_ip',
    description: 'Look up geolocation and network info for an IP address',
    inputSchema: {
      type: 'object',
      properties: {
        ip_address: { type: 'string', description: 'IPv4 or IPv6 address to look up' },
      },
      required: ['ip_address'],
    },
  },
  {
    name: 'get_random_user',
    description: 'Generate a random user profile for testing or mock data',
    inputSchema: { type: 'object' },
  },
  {
    name: 'fetch_post',
    description: 'Fetch a post by ID from JSONPlaceholder API',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'integer', description: 'The post ID (1-100)' },
      },
      required: ['post_id'],
    },
  },
];

/**
 * Get tool definitions for a template based on compute host.
 * Lambda template has multiple pre-defined tools with proper inputSchemas.
 * AgentCoreRuntime uses a single generic tool definition.
 */
export function getTemplateToolDefinitions(toolName: string, host: ComputeHost): ToolDefinition[] {
  if (host === 'Lambda') {
    // Prefix template tool names with the MCP tool name to avoid conflicts
    // when adding multiple Lambda tools to the same project
    return LAMBDA_TEMPLATE_TOOLS.map(tool => ({
      ...tool,
      name: `${toolName}_${tool.name}`,
    }));
  }
  // AgentCoreRuntime - single tool with generic schema
  return [
    {
      name: toolName,
      description: `Tool for ${toolName}`,
      inputSchema: { type: 'object' },
    },
  ];
}

/**
 * Renders an MCP tool project template to the specified output directory.
 * @param toolName - Name of the tool (used for {{ Name }} substitution)
 * @param outputDir - Target directory for the project
 * @param language - Target language ('Python' or 'TypeScript')
 * @param host - Compute host ('Lambda' or 'AgentCoreRuntime')
 */
export async function renderMcpToolTemplate(
  toolName: string,
  outputDir: string,
  language: TargetLanguage,
  host: ComputeHost = 'AgentCoreRuntime'
): Promise<void> {
  if (language !== 'Python') {
    throw new Error(`MCP tool templates for ${language} are not yet supported.`);
  }

  // Select template based on compute host
  const templateSubdir = host === 'Lambda' ? 'python-lambda' : 'python';
  const templateDir = getTemplatePath('mcp', templateSubdir);

  await copyAndRenderDir(templateDir, outputDir, { Name: toolName });
}
