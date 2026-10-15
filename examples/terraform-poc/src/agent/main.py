"""Small agent with deterministic memory/gateway probes and a model-backed path."""

import json
import os
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import Agent
from strands.models import BedrockModel

app = BedrockAgentCoreApp()


def call_gateway(method, params=None):
    session = boto3.Session()
    endpoint = os.environ["AGENTCORE_GATEWAY_TOOLS_URL"]
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    ).encode()
    request = AWSRequest(
        method="POST",
        url=endpoint,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    credentials = session.get_credentials().get_frozen_credentials()
    SigV4Auth(credentials, "bedrock-agentcore", session.region_name).add_auth(request)
    with urlopen(
        Request(endpoint, data=body, headers=dict(request.headers), method="POST"),
        timeout=30,
    ) as response:
        return json.loads(response.read())


@app.entrypoint
def invoke(payload, context):
    operation = payload.get("operation", "agent")
    if operation == "ping":
        return {"message": "Terraform runtime is responding."}
    if operation == "memory":
        client = boto3.client("bedrock-agentcore")
        memory_id = os.environ["MEMORY_MEMORY_ID"]
        actor_id = "terraform-poc"
        session_id = getattr(context, "session_id", None) or "terraform-poc"
        event = client.create_event(
            memoryId=memory_id,
            actorId=actor_id,
            sessionId=session_id,
            eventTimestamp=datetime.now(timezone.utc),
            payload=[
                {
                    "conversational": {
                        "content": {"text": payload.get("message", "I prefer green tea.")},
                        "role": "USER",
                    }
                }
            ],
        )
        events = client.list_events(
            memoryId=memory_id, actorId=actor_id, sessionId=session_id
        )
        return {
            "eventId": event["event"]["eventId"],
            "eventCount": len(events.get("events", [])),
        }
    if operation == "tools":
        return call_gateway("tools/list")
    if operation == "echo":
        return call_gateway(
            "tools/call",
            {
                "name": "echo___echo",
                "arguments": {"message": payload.get("message", "Hello from Terraform.")},
            },
        )
    if operation != "agent":
        raise ValueError("Expected operation: ping, memory, tools, echo, or agent.")
    agent = Agent(
        model=BedrockModel(
            model_id=os.environ.get("MODEL_ID", "us.amazon.nova-lite-v1:0")
        ),
        system_prompt="Give a concise, helpful answer to the user's question.",
    )
    result = agent(payload.get("prompt", "How can I keep a cup of tea warm?"))
    return {"response": str(result)}


if __name__ == "__main__":
    app.run()
