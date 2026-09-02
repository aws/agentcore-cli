from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    """Return a fixed greeting for every invocation."""
    return {"message": "Hello, world!"}


if __name__ == "__main__":
    app.run()
