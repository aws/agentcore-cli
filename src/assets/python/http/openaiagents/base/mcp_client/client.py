import os
import logging
from agents.mcp import MCPServerStreamableHttp

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
import httpx
from mcp_proxy_for_aws.sigv4_helper import SigV4HTTPXAuth, create_aws_session
{{/if}}
{{#if (includes gatewayAuthTypes "CUSTOM_JWT")}}
from bedrock_agentcore.identity import requires_access_token
{{/if}}

{{#each gatewayProviders}}
{{#if (eq authType "CUSTOM_JWT")}}
@requires_access_token(
    provider_name="{{credentialProviderName}}",
    scopes=[{{#if scopes}}"{{scopes}}"{{/if}}],
    auth_flow="M2M",
)
def _get_bearer_token_{{snakeCase name}}(*, access_token: str):
    """Obtain OAuth access token via AgentCore Identity for {{name}}."""
    return access_token

{{/if}}
{{/each}}

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
        {{else if (eq authType "CUSTOM_JWT")}}
        token = _get_bearer_token_{{snakeCase name}}()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        servers.append(MCPServerStreamableHttp(name="{{name}}", params={"url": url, "headers": headers}))
        {{else}}
        servers.append(MCPServerStreamableHttp(name="{{name}}", params={"url": url}))
        {{/if}}
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    return servers
{{else}}
{{#if isVpc}}
# VPC mode: external MCP endpoints are not reachable without a NAT gateway.
# Add an AgentCore Gateway with `agentcore add gateway`, or configure your own endpoint below.

def get_streamable_http_mcp_client() -> MCPServerStreamableHttp | None:
    """No MCP server configured. Add a gateway with `agentcore add gateway`."""
    return None
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
{{/if}}
