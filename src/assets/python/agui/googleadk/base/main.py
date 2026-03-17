from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from bedrock_agentcore.runtime import AGUIApp
from bedrock_agentcore.runtime.context import RequestContext
from ag_ui.core import (
    RunAgentInput,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from model.load import load_model


def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


agent = Agent(
    model=load_model(),
    name="{{ name }}",
    description="A helpful assistant that can use tools.",
    instruction="You are a helpful assistant. Use tools when appropriate.",
    tools=[add_numbers],
)

runner = Runner(
    app_name=agent.name,
    agent=agent,
    session_service=InMemorySessionService(),
)

app = AGUIApp()


@app.entrypoint
async def handle(input_data: RunAgentInput, context: RequestContext):
    yield RunStartedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)

    user_text = ""
    if input_data.messages:
        last = input_data.messages[-1]
        if hasattr(last, "content") and last.content:
            user_text = last.content

    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id="default-user"
    )
    response = await runner.run_async(
        user_id=session.user_id,
        session_id=session.id,
        new_message=user_text,
    )

    result_text = ""
    if response and response.events:
        for event in response.events:
            if hasattr(event, "content") and event.content:
                for part in event.content.parts:
                    if hasattr(part, "text"):
                        result_text += part.text

    msg_id = "msg-1"
    yield TextMessageStartEvent(message_id=msg_id, role="assistant")
    yield TextMessageContentEvent(message_id=msg_id, delta=result_text)
    yield TextMessageEndEvent(message_id=msg_id)

    yield RunFinishedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)


if __name__ == "__main__":
    app.run()
