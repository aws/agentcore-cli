import os
import logging
from langchain_mcp_adapters.client import MultiServerMCPClient

logger = logging.getLogger(__name__)

# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


def get_streamable_http_mcp_client() -> MultiServerMCPClient:
    """Returns an MCP Client compatible with LangChain/LangGraph."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MultiServerMCPClient(
        {
            "agentcore_gateway": {
                "transport": "streamable_http",
                "url": EXAMPLE_MCP_ENDPOINT,
            }
        }
    )
