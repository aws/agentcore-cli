import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
{{/if}}

{{#each gatewayProviders}}
def get_{{snakeCase name}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client connected to the {{name}} gateway."""
    url = os.environ.get("{{envVarName}}")
    if not url:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
        return None
    {{#if (eq authType "AWS_IAM")}}
    return MCPClient(lambda: aws_iam_streamablehttp_client(url, aws_service="bedrock-agentcore", aws_region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION"))))
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url))
    {{/if}}

{{/each}}
def get_all_gateway_mcp_clients() -> list[MCPClient]:
    """Returns MCP clients for all configured gateways."""
    clients = []
    {{#each gatewayProviders}}
    client = get_{{snakeCase name}}_mcp_client()
    if client:
        clients.append(client)
    {{/each}}
    return clients
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"

def get_streamable_http_mcp_client() -> MCPClient:
    """Returns an MCP Client compatible with Strands"""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MCPClient(lambda: streamablehttp_client(EXAMPLE_MCP_ENDPOINT))
{{/if}}
