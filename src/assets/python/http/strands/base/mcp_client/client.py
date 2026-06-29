import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
{{/if}}
{{#if (includes gatewayAuthTypes "CUSTOM_JWT")}}
from bedrock_agentcore.identity import requires_access_token
{{/if}}

{{#each gatewayProviders}}
{{#if (eq authType "CUSTOM_JWT")}}
@requires_access_token(
    provider_name="{{credentialProviderName}}",
    scopes=[{{#if scopes}}"{{scopes}}"{{/if}}],
    auth_flow="{{#if authFlow}}{{authFlow}}{{else}}M2M{{/if}}",
{{#if customParameters}}
    custom_parameters={{safeJson customParameters}},
{{/if}}
)
def _get_bearer_token_{{snakeCase name}}(*, access_token: str):
    """Obtain OAuth access token via AgentCore Identity for {{name}}."""
    return access_token

{{/if}}
{{/each}}
{{#each gatewayProviders}}
def get_{{snakeCase name}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client connected to the {{name}} gateway."""
    {{#if hardcodedUrl}}
    url = {{safeJson hardcodedUrl}}
    {{else}}
    url = os.environ.get("{{envVarName}}")
    if not url:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
        return None
    {{/if}}
    {{#if (eq authType "AWS_IAM")}}
    return MCPClient(lambda: aws_iam_streamablehttp_client(url, aws_service="bedrock-agentcore", aws_region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION"))), prefix="{{snakeCase name}}")
    {{else if (eq authType "CUSTOM_JWT")}}
    token = _get_bearer_token_{{snakeCase name}}()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return MCPClient(lambda: streamablehttp_client(url, headers=headers), prefix="{{snakeCase name}}")
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url), prefix="{{snakeCase name}}")
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
{{/if}}
{{#if remoteMcpTools}}
{{#if (some remoteMcpTools "headerCredentials")}}
from bedrock_agentcore.identity.auth import requires_api_key
{{/if}}
{{#each remoteMcpTools}}
{{#if headerCredentials}}
{{#each headerCredentials}}
@requires_api_key(provider_name="{{credentialName}}")
def _get_{{snakeCase ../name}}_{{snakeCase headerKey}}_key(api_key: str) -> str:
    """Fetch {{headerKey}} credential for {{../name}} from AgentCore Identity."""
    return api_key

{{/each}}
{{/if}}
def get_{{snakeCase name}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client for the {{name}} remote MCP server."""
    url = {{safeJson url}}
    {{#if headerCredentials}}
    if os.getenv("LOCAL_DEV") == "1":
        headers = { {{#each headerCredentials}}{{safeJson headerKey}}: os.environ.get("{{envVarName}}", ""){{#unless @last}}, {{/unless}}{{/each}} }
    else:
        headers = { {{#each headerCredentials}}{{safeJson headerKey}}: _get_{{snakeCase ../name}}_{{snakeCase headerKey}}_key(){{#unless @last}}, {{/unless}}{{/each}} }
    return MCPClient(lambda: streamablehttp_client(url, headers=headers))
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url))
    {{/if}}

{{/each}}
def get_all_remote_mcp_clients() -> list[MCPClient]:
    """Returns all configured remote MCP clients."""
    clients = [{{#each remoteMcpTools}}get_{{snakeCase name}}_mcp_client(){{#unless @last}}, {{/unless}}{{/each}}]
    return [c for c in clients if c is not None]
{{/if}}
{{#unless (or hasGateway remoteMcpTools)}}
{{#if isVpc}}
# VPC mode: external MCP endpoints are not reachable without a NAT gateway.
# Add an AgentCore Gateway with `agentcore add gateway`, or configure your own endpoint below.

def get_streamable_http_mcp_client() -> MCPClient | None:
    """No MCP server configured. Add a gateway with `agentcore add gateway`."""
    return None
{{else}}
{{#unless isExportHarness}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"

def get_streamable_http_mcp_client() -> MCPClient:
    """Returns an MCP Client compatible with Strands"""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MCPClient(lambda: streamablehttp_client(EXAMPLE_MCP_ENDPOINT))
{{/unless}}
{{/if}}
{{/unless}}
