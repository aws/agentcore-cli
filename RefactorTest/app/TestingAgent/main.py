from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_client

app = BedrockAgentCoreApp()
log = app.logger

# Define a Streamable HTTP MCP Client
mcp_client = get_streamable_http_mcp_client()

# Define a collection of tools used by the model
tools = []

# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a+b
tools.append(add_numbers)


_agent = None

def get_or_create_agent():
    global _agent
    if _agent is None:
        _agent = Agent(
            model=load_model(),
            system_prompt="""
                You are a helpful assistant. Use tools when appropriate.
            """,
            tools=tools+[mcp_client]
        )
    return _agent


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    agent = get_or_create_agent()

    # Execute and format response
    stream = agent.stream_async(payload.get("prompt"))

    async for event in stream:
        # Handle Text parts of the response
        if "data" in event and isinstance(event["data"], str):
            yield event["data"]


if __name__ == "__main__":
    app.run()
