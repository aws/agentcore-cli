from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_clients
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}
{{#if hasMemory}}
from memory.session import get_memory_session_manager
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

# Define a Streamable HTTP MCP Client
{{#if hasGateway}}
mcp_clients = get_all_gateway_mcp_clients()
{{else}}
mcp_clients = [get_streamable_http_mcp_client()]
{{/if}}

# Define a collection of tools used by the model
tools = []

# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a+b
tools.append(add_numbers)

# Add MCP client to tools if available
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)


{{#if hasMemory}}
def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, user_id):
        key = f"{session_id}/{user_id}"
        if key not in cache:
            # Create an agent for the given session_id and user_id
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, user_id),
                system_prompt="""
                    You are a helpful assistant. Use tools when appropriate.
                """,
                tools=tools
            )
        return cache[key]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{else}}
_agent = None

def get_or_create_agent():
    global _agent
    if _agent is None:
        _agent = Agent(
            model=load_model(),
            system_prompt="""
                You are a helpful assistant. Use tools when appropriate.
            """,
            tools=tools
        )
    return _agent
{{/if}}


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

{{#if hasMemory}}
    session_id = getattr(context, 'session_id', 'default-session')
    user_id = getattr(context, 'user_id', 'default-user')
    agent = get_or_create_agent(session_id, user_id)
{{else}}
    agent = get_or_create_agent()
{{/if}}

    # Execute and format response
    stream = agent.stream_async(payload.get("prompt"))

    async for event in stream:
        # Handle Text parts of the response
        if "data" in event and isinstance(event["data"], str):
            yield event["data"]


if __name__ == "__main__":
    app.run()
