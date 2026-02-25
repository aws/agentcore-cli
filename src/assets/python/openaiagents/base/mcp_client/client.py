import os
import logging
from agents.mcp import MCPServerStreamableHttp

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
import httpx
from mcp_proxy_for_aws.sigv4_helper import SigV4HTTPXAuth, create_aws_session
{{/if}}

def get_all_gateway_mcp_servers() -> list[MCPServerStreamableHttp]:
    """Returns MCP servers for all configured gateways."""
    servers = []
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        {{#if (eq authType "AWS_IAM")}}
        session = create_aws_session()
        auth = SigV4HTTPXAuth(session.get_credentials(), "bedrock-agentcore", session.region_name)
        servers.append(MCPServerStreamableHttp(
            name="{{name}}",
            params={"url": url, "httpx_client_factory": lambda **kwargs: httpx.AsyncClient(auth=auth, **kwargs)}
        ))
        {{else}}
        servers.append(MCPServerStreamableHttp(name="{{name}}", params={"url": url}))
        {{/if}}
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    return servers
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


def get_streamable_http_mcp_client() -> MCPServerStreamableHttp:
    """Returns an MCP Client compatible with OpenAI Agents SDK."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MCPServerStreamableHttp(
        name="AgentCore Gateway MCP", params={"url": EXAMPLE_MCP_ENDPOINT}
    )
{{/if}}
