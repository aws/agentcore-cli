"""
Lambda handler for AgentCore Gateway tools.

This template mirrors the FastMCP server tools but runs as a Lambda function
behind an AgentCore Gateway.

Tool routing uses bedrockAgentCoreToolName from client context:
  Format: {target_name}___{tool_name}
"""
import json
import logging
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

logger = logging.getLogger()
logger.setLevel(logging.INFO)

HTTP_TIMEOUT = 10
TOOLS = {}


def tool(name: str):
    """Decorator to register a tool handler."""
    def decorator(func):
        TOOLS[name] = func
        return func
    return decorator


def lambda_handler(event: Dict[str, Any], context) -> Dict[str, Any]:
    """Route incoming gateway requests to the appropriate tool."""
    try:
        extended_name = context.client_context.custom.get("bedrockAgentCoreToolName", "")
        tool_name = None

        if "___" in extended_name:
            tool_name = extended_name.split("___", 1)[1]

        if not tool_name:
            return _response(400, {"error": "Missing tool name in bedrockAgentCoreToolName"})

        handler = TOOLS.get(tool_name)
        if not handler:
            return _response(400, {"error": f"Unknown tool: {tool_name}"})

        result = handler(event)
        return _response(200, {"result": result})

    except Exception as e:
        logger.exception("Tool execution failed")
        return _response(500, {"error": str(e)})


def _response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Consistent JSON response wrapper."""
    return {"statusCode": status_code, "body": json.dumps(body)}


def _fetch_json(url: str) -> Optional[Dict[str, Any]]:
    """Fetch JSON from URL with error handling."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AgentCore-Tool/1.0"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to fetch {url}: {e}")
        return None


@tool("{{Name}}_lookup_ip")
def lookup_ip(event: Dict[str, Any]) -> str:
    """Look up geolocation and network info for an IP address.

    Args:
        ip_address: IPv4 or IPv6 address to look up
    """
    ip_address = event.get("ip_address", "")
    if not ip_address:
        return "Missing required parameter: ip_address"

    data = _fetch_json(f"http://ip-api.com/json/{ip_address}")
    if not data:
        return f"Failed to look up IP: {ip_address}"

    if data.get("status") == "fail":
        return f"Lookup failed: {data.get('message', 'unknown error')}"

    return (
        f"IP: {data['query']}\n"
        f"Location: {data['city']}, {data['regionName']}, {data['country']}\n"
        f"ISP: {data['isp']}\n"
        f"Organization: {data['org']}\n"
        f"Timezone: {data['timezone']}"
    )


@tool("{{Name}}_get_random_user")
def get_random_user(event: Dict[str, Any]) -> str:
    """Generate a random user profile for testing or mock data."""
    data = _fetch_json("https://randomuser.me/api/")
    if not data or "results" not in data:
        return "Failed to generate random user."

    user = data["results"][0]
    name = user["name"]
    location = user["location"]

    return (
        f"Name: {name['first']} {name['last']}\n"
        f"Email: {user['email']}\n"
        f"Location: {location['city']}, {location['country']}\n"
        f"Phone: {user['phone']}"
    )


@tool("{{Name}}_fetch_post")
def fetch_post(event: Dict[str, Any]) -> str:
    """Fetch a post by ID from JSONPlaceholder API.

    Args:
        post_id: The post ID (1-100)
    """
    post_id = event.get("post_id")
    if post_id is None:
        return "Missing required parameter: post_id"

    try:
        post_id = int(post_id)
    except (TypeError, ValueError):
        return "post_id must be an integer"

    if not 1 <= post_id <= 100:
        return "Post ID must be between 1 and 100."

    data = _fetch_json(f"https://jsonplaceholder.typicode.com/posts/{post_id}")
    if not data:
        return f"Failed to fetch post {post_id}."

    return (
        f"Post #{data['id']}\n"
        f"Title: {data['title']}\n\n"
        f"{data['body']}"
    )
