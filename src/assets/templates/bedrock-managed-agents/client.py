"""Send an input to a Bedrock Managed Agents session that uses this project's ACR."""

import argparse
import json
from pathlib import Path
from typing import Any

from aws_bedrock_token_generator import provide_token
from openai import NotFoundError, OpenAI

BMA_MODEL_ID = "openai.gpt-5.6-luna"
WORKSPACE_DIRECTORY = "/home/app/workspace"
CAPABILITY_DIRECTORIES = ["/opt/bma/plugins"]
TURN_END = ("completed", "failed", "cancelled")
TOOL_CALLS = ("mcp_call", "function_call", "web_search_call")


def deployed_session_role(runtime_arn: str) -> str:
    """Find the CDK-managed session role deployed alongside this Runtime."""
    project_root = Path(__file__).resolve().parents[2]
    state_path = project_root / "agentcore" / ".cli" / "deployed-state.json"
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read {state_path}: {error}") from error

    matches = []
    for target in state.get("targets", {}).values():
        session = target.get("resources", {}).get("bmaSession") or {}
        if runtime_arn in session.get("runtimeArns", []):
            matches.append(session["roleArn"])
    if len(matches) != 1:
        raise ValueError(
            f"Expected one deployed BMA session role for {runtime_arn}, found {len(matches)}. "
            "Run agentcore deploy, or give --role-arn."
        )
    return matches[0]


def show(data: dict[str, Any]) -> None:
    """Prints the session ID, the commands, the tool calls, and the answer."""
    kind = data["type"].removeprefix("agent.session.")
    item = data.get("item") or {}
    if kind == "created":
        print(f"Session {data['session']['id']}")
    elif kind == "turn.output_text.delta":
        print(data["delta"], end="", flush=True)
    elif kind == "turn.item.done" and item.get("type") == "command_execution":
        print(f"\n$ {item['command']}\n{item.get('output') or ''}".rstrip())
    elif kind == "turn.item.done" and item.get("type") in TOOL_CALLS:
        print(f"\nTool {item.get('name') or item['type']} {item.get('status')}")
    elif kind == "error" or kind.split(".")[-1] in TURN_END:
        source = data.get("turn") or data.get("environment") or data.get("session")
        print(f"\n{kind} {(source or data).get('error') or ''}".rstrip())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, help="The ACR ARN.")
    parser.add_argument(
        "--session-id",
        help="The BMA session ID. If it does not exist, the client creates a session.",
    )
    parser.add_argument(
        "--input",
        default="Use the acr-report skill to save an ACR report in the workspace.",
    )
    parser.add_argument(
        "--gateway",
        help="The Gateway URL from the output of `agentcore deploy`.",
    )
    parser.add_argument(
        "--role-arn",
        help="Use this BMA session role instead of the CDK-managed role for the Runtime.",
    )
    parser.add_argument("--delete", action="store_true", help="Delete the session.")
    parser.add_argument("--raw", action="store_true", help="Print events as JSON.")
    args = parser.parse_args()
    # BMA must run in the Region of the ACR.
    region = args.runtime.split(":")[3]

    with OpenAI(
        api_key=lambda: provide_token(region=region),
        base_url=f"https://bedrock-mantle.{region}.api.aws/openai/v1",
    ) as client:
        sessions = client.beta.agents.sessions
        session_id = args.session_id
        if session_id:
            try:
                session = sessions.retrieve(session_id).model_dump(warnings=False)
            except NotFoundError:
                print(f"Session {session_id} does not exist.")
                session_id = None
            else:
                if session["environment"].get("runtime_arn") != args.runtime:
                    raise ValueError(f"Session {session_id} uses another ACR.")

        if not session_id and not args.role_arn:
            try:
                args.role_arn = deployed_session_role(args.runtime)
            except ValueError as error:
                parser.error(str(error))

        if session_id:
            # BMA opens the stream only with stream=true, and the SDK does not send it.
            events = sessions.events.stream(session_id, extra_query={"stream": "true"})
            message = {
                "role": "user",
                "content": [{"type": "input_text", "text": args.input}],
            }
            sessions.events.create(
                session_id,
                events=[{"type": "agent.session.input.message", "input": [message]}],
            )
        else:
            agent: dict[str, Any] = {
                "model": BMA_MODEL_ID,
                "instructions": "Use the available tools to complete the task.",
            }
            if args.gateway:
                # Bedrock Managed Agents calls Gateway with IAM from the service side.
                agent["tools"] = [
                    {
                        "type": "mcp",
                        "server_label": "team_tools",
                        "required": True,
                        "connection_origin": "service",
                        "transport": {"type": "http", "server_url": args.gateway},
                    }
                ]
                args.input += (
                    " Then use the Gateway's documentation and runbook tools to explain"
                    " how to investigate an MCP connection failure. Cite your sources."
                )
            events = sessions.create(
                agent=agent,
                environment={
                    "type": "aws_bedrock_agentcore",
                    "runtime_arn": args.runtime,
                    "runtime_qualifier": "DEFAULT",
                    "workspace_directory": WORKSPACE_DIRECTORY,
                    "capability_directories": CAPABILITY_DIRECTORIES,
                },
                input=args.input,
                stream=True,
                extra_body={"role_arn": args.role_arn},
            )

        with events:
            for event in events:
                data = event.model_dump(mode="json", warnings=False)
                session_id = session_id or (data.get("session") or {}).get("id")
                if args.raw:
                    print(json.dumps(data), flush=True)
                else:
                    show(data)
                if data["type"].removeprefix("agent.session.turn.") in TURN_END:
                    break

        if args.delete:
            sessions.delete(session_id)
            print(f"\nDeleted session {session_id}")


if __name__ == "__main__":
    main()
