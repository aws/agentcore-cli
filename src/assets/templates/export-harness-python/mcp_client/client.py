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
{{#if gatewayTools}}
import httpx

{{/if}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import get_session


class _SigV4Auth(httpx.Auth):
    """Signs each gateway request with SigV4 using the runtime's AWS credentials."""

    requires_request_body = True

    def __init__(self):
        region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION"))
        self._signer = SigV4Auth(get_session().get_credentials(), "bedrock-agentcore", region)

    def auth_flow(self, request):
        # The gateway does not sign the connection header, so leave it out of the signature.
        headers = {k: v for k, v in request.headers.items() if k.lower() != "connection"}
        signed = AWSRequest(method=request.method, url=str(request.url), data=request.content, headers=headers)
        self._signer.add_auth(signed)
        request.headers.update(dict(signed.headers))
        yield request

{{/if}}
{{#if (includes gatewayAuthTypes "OAUTH")}}
from bedrock_agentcore.identity.auth import requires_access_token


class _BearerAuth(httpx.Auth):
    """Sends an AgentCore Identity access token, fetching a new one when the gateway rejects it."""

    requires_request_body = True

    def __init__(self, get_token):
        self._get_token = get_token
        self._token = None

    async def async_auth_flow(self, request):
        if self._token is None:
            self._token = await self._get_token()
        request.headers["Authorization"] = f"Bearer {self._token}"
        response = yield request
        if response.status_code == 401:
            self._token = await self._get_token()
            request.headers["Authorization"] = f"Bearer {self._token}"
            yield request

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
async def _get_{{pythonName}}_token(*, access_token: str) -> str:
    """Fetch an OAuth access token for the {{name}} gateway from AgentCore Identity."""
    return access_token

{{/if}}
def get_{{pythonName}}_mcp_client() -> MCPClient | None:
    """Returns an MCP Client for the {{name}} AgentCore Gateway."""
    url = os.environ.get("{{urlEnvVarName}}")
    if not url:
        logger.warning("{{urlEnvVarName}} is not set; {{name}} gateway tools are unavailable")
        return None
    {{#if (eq authType "AWS_IAM")}}
    auth = _SigV4Auth()
    {{/if}}
    {{#if oauth}}
    auth = _BearerAuth(_get_{{pythonName}}_token)
    {{/if}}
    {{#if (eq authType "NONE")}}
    auth = None
    {{/if}}
    return MCPClient(lambda: streamablehttp_client(url, auth=auth){{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})

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

    return MCPClient(transport, prefix={{safeJson name}}{{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
    {{else}}
    return MCPClient(lambda: streamablehttp_client(url), prefix={{safeJson name}}{{#if toolPatterns}}, tool_filters=_allowed_tools({{safeJson name}}, {{#each toolPatterns}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}){{/if}})
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
