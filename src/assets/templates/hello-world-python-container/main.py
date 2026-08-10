from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent

app = BedrockAgentCoreApp()
agent = Agent(system_prompt="You are a helpful assistant.")


@app.entrypoint
async def invoke(payload, context):
    """Stream the agent's response to the caller's prompt."""
    prompt = payload.get("prompt", "Hello!")
    async for event in agent.stream_async(prompt):
        yield event


if __name__ == "__main__":
    app.run()
