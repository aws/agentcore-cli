from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import AgentCapabilities, AgentCard, AgentSkill, Part, TextPart
from a2a.utils import new_task
from bedrock_agentcore.runtime import serve_a2a
from model.load import load_model


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


model = load_model()
graph = create_react_agent(model, tools=[add_numbers])


class LangGraphA2AExecutor(AgentExecutor):
    """Wraps a LangGraph CompiledGraph as an a2a-sdk AgentExecutor."""

    def __init__(self, graph):
        self.graph = graph

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task = context.current_task or new_task(context.message)
        if not context.current_task:
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)

        user_text = context.get_user_input()
        result = await self.graph.ainvoke({"messages": [("user", user_text)]})
        response = result["messages"][-1].content

        await updater.add_artifact([Part(root=TextPart(text=response))])
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        pass


card = AgentCard(
    name="{{ name }}",
    description="A LangGraph agent on Bedrock AgentCore",
    url="http://localhost:9000/",
    version="0.1.0",
    capabilities=AgentCapabilities(streaming=True),
    skills=[
        AgentSkill(
            id="tools",
            name="tools",
            description="Use tools to help answer questions",
            tags=["tools"],
        )
    ],
    default_input_modes=["text"],
    default_output_modes=["text"],
)

if __name__ == "__main__":
    serve_a2a(LangGraphA2AExecutor(graph), card)
