import os
import logging
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
import httpx
from mcp_proxy_for_aws.sigv4_helper import SigV4HTTPXAuth, create_aws_session
{{/if}}

def get_all_gateway_mcp_toolsets() -> list[MCPToolset]:
    """Returns MCP Toolsets for all configured gateways."""
    toolsets = []
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        {{#if (eq authType "AWS_IAM")}}
        session = create_aws_session()
        auth = SigV4HTTPXAuth(session.get_credentials(), "bedrock-agentcore", session.region_name)
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(
            url=url,
            httpx_client_factory=lambda **kwargs: httpx.AsyncClient(auth=auth, **kwargs)
        )))
        {{else}}
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(url=url)))
        {{/if}}
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    return toolsets
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


def get_streamable_http_mcp_client() -> MCPToolset:
    """Returns an MCP Toolset compatible with Google ADK."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MCPToolset(
        connection_params=StreamableHTTPConnectionParams(url=EXAMPLE_MCP_ENDPOINT)
    )
{{/if}}
