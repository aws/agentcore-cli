"""Send an input to a Bedrock Managed Agents session that uses this project's ACR."""

import argparse
import json
import time
from pathlib import Path
from typing import Any

import boto3
from aws_bedrock_token_generator import provide_token
from botocore.exceptions import ClientError
from openai import NotFoundError, OpenAI

BMA_MODEL_ID = "openai.gpt-5.6-luna"
WORKSPACE_DIRECTORY = "/home/app/workspace"
CAPABILITY_DIRECTORIES = ["/opt/bma/plugins"]
TURN_END = ("completed", "failed", "cancelled")
TOOL_CALLS = ("mcp_call", "function_call", "web_search_call")
POLICIES = Path(__file__).parent / "policies"
SESSION_ROLE = "BmaSessionRole-{region}"
SESSION_POLICY = "BmaSession"


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


def load_policy(name: str, partition: str, region: str, account: str) -> str:
    """Reads a policy file and puts in the partition, the Region, and the account."""
    text = (POLICIES / name).read_text()
    for key, value in (("Partition", partition), ("Region", region), ("AccountId", account)):
        text = text.replace("${AWS::" + key + "}", value)
    return text


def session_role(runtime_arn: str) -> str:
    """Creates or repairs the session role, and returns its ARN.

    If the trust policy or the policy of the role is not the same as the file in `policies/`,
    the client writes the file to the role.
    """
    _, partition, _, region, account = runtime_arn.split(":")[:5]
    name = SESSION_ROLE.format(region=region)
    trust = load_policy("bma-session-trust.json", partition, region, account)
    policy = load_policy("bma-session-policy.json", partition, region, account)
    iam = boto3.client("iam")
    changed = False
    try:
        role = iam.get_role(RoleName=name)["Role"]
    except iam.exceptions.NoSuchEntityException:
        role = iam.create_role(RoleName=name, AssumeRolePolicyDocument=trust)["Role"]
        print(f"Created the session role {name}")
        changed = True
    else:
        if role["AssumeRolePolicyDocument"] != json.loads(trust):
            iam.update_assume_role_policy(RoleName=name, PolicyDocument=trust)
            print(f"Updated the trust policy of {name}")
            changed = True
    try:
        current = iam.get_role_policy(RoleName=name, PolicyName=SESSION_POLICY)["PolicyDocument"]
    except iam.exceptions.NoSuchEntityException:
        current = None
    if current != json.loads(policy):
        iam.put_role_policy(RoleName=name, PolicyName=SESSION_POLICY, PolicyDocument=policy)
        if not changed:
            print(f"Updated the policy of {name}")
        changed = True
    if changed:
        # IAM needs some seconds before BMA can use a new or changed role.
        time.sleep(15)
    return role["Arn"]


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
        help="The Gateway ARN from the output of `agentcore deploy`.",
    )
    parser.add_argument(
        "--role-arn",
        help="The session role that BMA assumes. If you do not give it, the client creates a role.",
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
                args.role_arn = session_role(args.runtime)
            except ClientError as error:
                parser.error(
                    f"The client cannot create or check the session role: {error}. "
                    "Get the IAM permissions in README.md, or give --role-arn."
                )
            print(f"Session role {args.role_arn}")

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
                # Bedrock Managed Agents calls Gateway with the session role from the service side.
                agent["tools"] = [
                    {"type": "mcp", "server_label": "team_tools", "connector_id": args.gateway}
                ]
                args.input += " Then list the tools that the Gateway gives you."
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
                # The SDK has no role_arn parameter. BMA assumes this role to call the ACR.
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
