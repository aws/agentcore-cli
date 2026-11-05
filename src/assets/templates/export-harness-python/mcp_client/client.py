import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

{{#if (or (some remoteMcpTools "toolPatterns") (some gatewayTools "toolPatterns"))}}
import fnmatch


def _allowed_tools(server, *patterns):
    """Load only the tools allowedTools selects, by the server's name or as <server>_<tool>."""
    def allowed(tool, **_):
        names = (tool.mcp_tool.name, f"{server}_{tool.mcp_tool.name}")
        return any(fnmatch.fnmatchcase(name, pattern) for name in names for pattern in patterns)
    return {"allowed": [allowed]}

{{/if}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

{{/if}}
{{#if (includes gatewayAuthTypes "OAUTH")}}
from bedrock_agentcore.identity.auth import requires_access_token

{{/if}}
{{#each gatewayTools}}
{{#if oauth}}
@requires_access_token(
    provider_name={{safeJson oauth.providerName}},
    scopes={{safeJson oauth.scopes}},
    auth_flow="M2M",
{{#if oauth.customParameters}}
    custom_parameters={{safeJson oauth.customParameters}},
{{/if}}
)
def _get_{{pythonName}}_token(*, access_token: str) -> str:
    """Fetch an OAuth access token for the {{name}} gateway from AgentCore Identity."""
    return access_token

{{/if}}
def get_{{pythonName}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client for the {{name}} AgentCore Gateway."""
    url = os.environ.get("{{urlEnvVarName}}")
    if not url:
        logger.warning("{{urlEnvVarName}} is not set; {{name}} gateway tools are unavailable")
        return None
    def transport():
    {{#if (eq authType "AWS_IAM")}}
        return aws_iam_streamablehttp_client(url, aws_service="bedrock-agentcore", aws_region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION")))
    {{/if}}
    {{#if oauth}}
        return streamablehttp_client(url, headers={"Authorization": f"Bearer {_get_{{pythonName}}_token()}"})
    {{/if}}
    {{#if (eq authType "NONE")}}
        return streamablehttp_client(url)
    {{/if}}

    return MCPClient(transport{{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})

{{/each}}
{{#if remoteMcpTools}}
{{#if (some remoteMcpTools "headerCredentials")}}
from bedrock_agentcore.identity.auth import requires_api_key
{{/if}}
{{#each remoteMcpTools}}
{{#if headerCredentials}}
{{#each headerCredentials}}
@requires_api_key(provider_name="{{credentialName}}")
def _get_{{pythonName}}_key(api_key: str) -> str:
    """Fetch {{headerKey}} credential for {{../name}} from AgentCore Identity."""
    return api_key

{{/each}}
{{/if}}
def get_{{pythonName}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client for the {{name}} remote MCP server."""
    url = {{safeJson url}}
    {{#if headerCredentials}}
    def transport():
        if os.getenv("LOCAL_DEV") == "1":
            headers = { {{#each headerCredentials}}{{safeJson headerKey}}: os.environ.get("{{envVarName}}", ""){{#unless @last}}, {{/unless}}{{/each}} }
        else:
            headers = { {{#each headerCredentials}}{{safeJson headerKey}}: _get_{{pythonName}}_key(){{#unless @last}}, {{/unless}}{{/each}} }
        return streamablehttp_client(url, headers=headers)

    return MCPClient(transport{{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url){{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{/if}}

{{/each}}
{{/if}}
{{#if (or gatewayTools remoteMcpTools)}}
def get_all_mcp_clients() -> list[MCPClient]:
    """Returns all configured gateway and remote MCP clients."""
    clients = [
{{#each gatewayTools}}
        get_{{pythonName}}_mcp_client(),
{{/each}}
{{#each remoteMcpTools}}
        get_{{pythonName}}_mcp_client(),
{{/each}}
    ]
    return [c for c in clients if c is not None]
{{/if}}
{{#unless (or gatewayTools remoteMcpTools)}}
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
