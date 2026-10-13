import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient
{{#if hasIamGateway}}
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
{{/if}}
{{#if (some remoteMcpTools "toolPatterns")}}
import fnmatch
{{/if}}
{{#if (some remoteMcpTools "headerCredentials")}}
from bedrock_agentcore.identity.auth import requires_api_key
{{/if}}

logger = logging.getLogger(__name__)

{{#if remoteMcpTools}}
{{#if (some remoteMcpTools "toolPatterns")}}
def _allowed_tools(server, *patterns):
    """Load only the tools allowedTools selects, by the server's name or as <server>_<tool>."""
    def allowed(tool, **_):
        names = (tool.mcp_tool.name, f"{server}_{tool.mcp_tool.name}")
        return any(fnmatch.fnmatchcase(name, pattern) for name in names for pattern in patterns)
    return {"allowed": [allowed]}

{{/if}}
{{#each remoteMcpTools}}
{{#if headerCredentials}}
{{#each headerCredentials}}
@requires_api_key(provider_name={{#if existing}}{{safeJson credentialName}}{{else}}os.environ.get("{{envVarName}}_NAME", {{safeJson credentialName}}){{/if}})
def _get_{{pythonName}}_key(api_key: str) -> str:
    """Fetch {{headerKey}} credential for {{../name}} from AgentCore Identity."""
    return api_key

{{/each}}
{{/if}}
def get_{{pythonName}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client for the {{name}} remote MCP server."""
    {{#if urlEnvVar}}
    url = os.environ.get("{{urlEnvVar}}")
    if not url:
        raise RuntimeError("Missing gateway endpoint: {{urlEnvVar}}")
    {{else}}
    url = {{safeJson url}}
    {{/if}}
    {{#if headerCredentials}}
    def transport():
        if os.getenv("LOCAL_DEV") == "1":
            headers = { {{#each headerCredentials}}{{safeJson headerKey}}: {{#if existing}}{{safeJson prefix}} + {{/if}}os.environ["{{envVarName}}"]{{#if existing}} + {{safeJson suffix}}{{/if}}{{#unless @last}}, {{/unless}}{{/each}} }
        else:
            headers = { {{#each headerCredentials}}{{safeJson headerKey}}: {{#if existing}}{{safeJson prefix}} + {{/if}}_get_{{pythonName}}_key(){{#if existing}} + {{safeJson suffix}}{{/if}}{{#unless @last}}, {{/unless}}{{/each}} }
        return streamablehttp_client(url, headers=headers)

    return MCPClient(transport{{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{else}}
    {{#if awsIam}}
    return MCPClient(lambda: aws_iam_streamablehttp_client(endpoint=url, aws_service="bedrock-agentcore", aws_region={{safeJson awsRegion}}){{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url){{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{/if}}
    {{/if}}

{{/each}}
def get_all_remote_mcp_clients() -> list[MCPClient]:
    """Returns all configured remote MCP clients."""
    clients = [{{#each remoteMcpTools}}get_{{pythonName}}_mcp_client(){{#unless @last}}, {{/unless}}{{/each}}]
    return [c for c in clients if c is not None]
{{/if}}
{{#unless remoteMcpTools}}
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
