import { McpClient } from '@strands-agents/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
const EXAMPLE_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';

export function getStreamableHttpMcpClient(): McpClient {
  // to use an MCP server that supports bearer authentication, add a headers() callback to requestInit
  const transport = new StreamableHTTPClientTransport(new URL(EXAMPLE_MCP_ENDPOINT));
  return new McpClient({ transport });
}
