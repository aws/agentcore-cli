from langchain.agents import create_agent
from langchain.tools import tool
from langchain_core.messages import AIMessageChunk
from langgraph.checkpoint.memory import InMemorySaver
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model

app = BedrockAgentCoreApp()

SYSTEM_PROMPT = "You are a helpful assistant. Use tools when appropriate."


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


tools = [add_numbers]

agent = create_agent(
    model=load_model(),
    tools=tools,
    system_prompt=SYSTEM_PROMPT,
    checkpointer=InMemorySaver(),
)


@app.entrypoint
async def invoke(payload, context):
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    if not isinstance(prompt, str) or not prompt:
        yield {"error": "payload must be a JSON object with a non-empty string 'prompt'"}
        return

    session_id = context.session_id or "default-session"
    config = {"configurable": {"thread_id": session_id}}

    async for event in agent.astream(
        {"messages": [{"role": "user", "content": prompt}]},
        config,
        stream_mode="messages",
        version="v2",
    ):
        message, metadata = event["data"]
        if not isinstance(message, AIMessageChunk):
            continue
        blocks = message.content_blocks
        if blocks:
            yield {"node": metadata["langgraph_node"], "content": blocks}


if __name__ == "__main__":
    app.run()
