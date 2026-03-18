from crewai import Agent, Crew, Task, Process
from crewai.tools import tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model

app = BedrockAgentCoreApp()
log = app.logger


# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Define a collection of tools used by the model
tools = [add_numbers]


@app.entrypoint
def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Define the Agent with Tools
    agent = Agent(
        role="Question Answering Assistant",
        goal="Answer the users questions",
        backstory="Always eager to answer any questions",
        llm=load_model(),
        tools=tools,
    )

    # Define the Task
    task = Task(
        agent=agent,
        description="Answer the users question: {prompt}",
        expected_output="An answer to the users question",
    )

    # Create the Crew
    crew = Crew(agents=[agent], tasks=[task], process=Process.sequential)

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")

    # Run the crew
    result = crew.kickoff(inputs={"prompt": prompt})

    # Return result
    return {"result": result.raw}


if __name__ == "__main__":
    app.run()
