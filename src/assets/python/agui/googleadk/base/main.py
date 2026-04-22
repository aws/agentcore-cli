import os
import uvicorn
from google.adk.agents import LlmAgent
from ag_ui_adk import ADKAgent, AGUIToolset, create_adk_app
from model.load import load_model

load_model()

agent = LlmAgent(
    name="{{ name }}",
    model="gemini-2.5-flash",
    instruction="You are a helpful assistant.",
    tools=[AGUIToolset()],
)

adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="{{ name }}",
    use_in_memory_services=True,
)

app = create_adk_app(adk_agent, path="/invocations")


@app.get("/ping")
async def ping():
    return {"status": "healthy"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
