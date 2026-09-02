from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    """Add agent logic here"""
    return {"message": "Hello, world!"}


if __name__ == "__main__":
    app.run()
