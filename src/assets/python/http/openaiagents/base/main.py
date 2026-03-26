import os
from agents import Agent, Runner, function_tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_servers
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

# Get MCP Server
{{#if hasGateway}}
mcp_servers = get_all_gateway_mcp_servers()
{{else}}
mcp_server = get_streamable_http_mcp_client()
mcp_servers = [mcp_server] if mcp_server else []
{{/if}}

_credentials_loaded = False

def ensure_credentials_loaded():
    global _credentials_loaded
    if not _credentials_loaded:
        load_model()
        _credentials_loaded = True


# Define a simple function tool
@function_tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Define the agent execution
async def main(query):
    ensure_credentials_loaded()
    try:
        {{#if hasGateway}}
        if mcp_servers:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                mcp_servers=mcp_servers,
                tools=[add_numbers]
            )
            result = await Runner.run(agent, query)
            return result
        else:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                mcp_servers=[],
                tools=[add_numbers]
            )
            result = await Runner.run(agent, query)
            return result
        {{else}}
        if mcp_servers:
            async with mcp_servers[0] as server:
                active_servers = [server]
                agent = Agent(
                    name="{{ name }}",
                    model="gpt-4.1",
                    mcp_servers=active_servers,
                    tools=[add_numbers]
                )
                result = await Runner.run(agent, query)
                return result
        else:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                mcp_servers=[],
                tools=[add_numbers]
            )
            result = await Runner.run(agent, query)
            return result
        {{/if}}
    except Exception as e:
        log.error(f"Error during agent execution: {e}", exc_info=True)
        raise e


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")

    # Run the agent
    result = await main(prompt)

    # Return result
    return {"result": result.final_output}


if __name__ == "__main__":
    app.run()
