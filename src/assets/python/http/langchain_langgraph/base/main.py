import os
from langchain_core.messages import HumanMessage
from langgraph.prebuilt import create_react_agent
from langchain.tools import tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_client
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

_llm = None

def get_or_create_model():
    global _llm
    if _llm is None:
        _llm = load_model()
    return _llm


# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Define a collection of tools used by the model
tools = [add_numbers]


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Get MCP Client
    {{#if hasGateway}}
    mcp_client = get_all_gateway_mcp_client()
    {{else}}
    mcp_client = get_streamable_http_mcp_client()
    {{/if}}

    # Load MCP Tools
    mcp_tools = []
    if mcp_client:
        mcp_tools = await mcp_client.get_tools()

    # Define the agent using create_react_agent
    graph = create_react_agent(get_or_create_model(), tools=mcp_tools + tools)

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    log.info(f"Agent input: {prompt}")

    # Run the agent
    result = await graph.ainvoke({"messages": [HumanMessage(content=prompt)]})

    # Return result
    output = result["messages"][-1].content
    log.info(f"Agent output: {output}")
    return {"result": output}


if __name__ == "__main__":
    app.run()
