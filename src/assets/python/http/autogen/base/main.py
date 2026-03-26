import os
from autogen_agentchat.agents import AssistantAgent
from autogen_core.tools import FunctionTool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_tools

app = BedrockAgentCoreApp()
log = app.logger


# Define a simple function tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


add_numbers_tool = FunctionTool(
    add_numbers, description="Return the sum of two numbers"
)

# Define a collection of tools used by the model
tools = [add_numbers_tool]


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Get MCP Tools
    mcp_tools = await get_streamable_http_mcp_tools()

    # Define an AssistantAgent with the model and tools
    agent = AssistantAgent(
        name="{{ name }}",
        model_client=load_model(),
        tools=tools + mcp_tools,
        system_message="You are a helpful assistant. Use tools when appropriate.",
    )

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")

    # Run the agent
    result = await agent.run(task=prompt)

    # Return result
    return {"result": result.messages[-1].content}


if __name__ == "__main__":
    app.run()
