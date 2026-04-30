"""Invoke Bedrock AgentCore Harness to review a GitHub PR.

Reads PR_URL from the environment. Streams harness output to stdout.
Uses the boto3 bedrock-agentcore client's invoke_harness API.
"""

import json
import os
import sys
import time
import uuid

import boto3

# ANSI color codes
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

SCRIPTS_DIR = os.path.dirname(__file__)


def read_prompt(filename):
    """Read a prompt template from the prompts directory."""
    path = os.path.join(SCRIPTS_DIR, "prompts", filename)
    with open(path) as f:
        return f.read()


def invoke_harness_streaming(harness_arn, session_id, system_prompt, messages, model_id, region):
    """Call invoke_harness via boto3 and return the event stream."""
    client = boto3.client("bedrock-agentcore", region_name=region)
    response = client.invoke_harness(
        harnessArn=harness_arn,
        runtimeSessionId=session_id,
        systemPrompt=[{"text": system_prompt}],
        messages=messages,
        model={"bedrockModelConfig": {"modelId": model_id}},
    )
    return response["stream"]


def parse_events(event_stream):
    """Yield (event_type, payload) tuples from the boto3 event stream."""
    for event in event_stream:
        if "contentBlockStart" in event:
            yield "contentBlockStart", event["contentBlockStart"]
        elif "contentBlockDelta" in event:
            yield "contentBlockDelta", event["contentBlockDelta"]
        elif "contentBlockStop" in event:
            yield "contentBlockStop", event["contentBlockStop"]
        elif "messageStop" in event:
            yield "messageStop", event["messageStop"]
        elif "internalServerException" in event:
            yield "internalServerException", event["internalServerException"]
        elif "runtimeClientError" in event:
            yield "runtimeClientError", event["runtimeClientError"]


def print_stream(event_stream):
    """Display harness events with GitHub Actions log groups.

    The harness streams events as the agent works:
      contentBlockStart  — a new block begins (text or tool call)
      contentBlockDelta  — incremental chunks of text or tool input JSON
      contentBlockStop   — block complete, we now have full tool input to display
      messageStop        — agent finished
      internalServerException — server error

    Tool calls are wrapped in ::group::/::endgroup:: for collapsible sections
    in the GitHub Actions log UI. Agent reasoning text is printed inline in dim.
    """
    start_time = time.time()
    iteration = 0
    tool_name = None
    tool_input = ""
    tool_start = 0.0
    in_group = False
    text_buffer = ""

    def close_group():
        nonlocal in_group
        if in_group:
            print("::endgroup::", flush=True)
            in_group = False

    def flush_text():
        nonlocal text_buffer
        if text_buffer:
            for line in text_buffer.splitlines():
                print(f"{DIM}{line}{RESET}", flush=True)
            text_buffer = ""

    for event_type, payload in parse_events(event_stream):

        if event_type == "contentBlockStart":
            start = payload.get("start", {})
            if "toolUse" in start:
                tool_name = start["toolUse"].get("name", "unknown")
                tool_input = ""
                tool_start = time.time()
                iteration += 1

        elif event_type == "contentBlockDelta":
            delta = payload.get("delta", {})
            if "text" in delta:
                close_group()
                text_buffer += delta["text"]
            if "toolUse" in delta:
                tool_input += delta["toolUse"].get("input", "")

        elif event_type == "contentBlockStop":
            flush_text()
            if tool_name:
                elapsed = time.time() - tool_start
                try:
                    parsed = json.loads(tool_input)
                except (json.JSONDecodeError, TypeError):
                    parsed = tool_input

                close_group()

                cmd = parsed.get("command") if isinstance(parsed, dict) else None
                header = f"{CYAN}[{iteration}]{RESET} {YELLOW}{tool_name}{RESET} {DIM}({elapsed:.1f}s){RESET}"
                if cmd:
                    header += f": $ {cmd}"

                print(f"::group::{header}", flush=True)
                in_group = True

                if isinstance(parsed, dict):
                    for k, v in parsed.items():
                        if k != "command":
                            print(f"  {DIM}{k}:{RESET} {str(v)[:300]}", flush=True)

            tool_name = None
            tool_input = ""

        elif event_type == "messageStop":
            flush_text()
            close_group()
            if payload.get("stopReason") == "end_turn":
                total = time.time() - start_time
                print(f"\n\n{GREEN}{'=' * 50}", flush=True)
                print(f"  Done ({int(total // 60)}m {int(total % 60)}s)", flush=True)
                print(f"{'=' * 50}{RESET}", flush=True)

        elif event_type == "internalServerException":
            close_group()
            print(f"\n{RED}ERROR: {payload}{RESET}", file=sys.stderr)
            sys.exit(1)

        elif event_type == "runtimeClientError":
            close_group()
            print(f"\n{RED}ERROR: {payload.get('message', payload)}{RESET}", file=sys.stderr)
            sys.exit(1)

    close_group()
    total = time.time() - start_time
    print(f"\n{GREEN}Review complete.{RESET} {DIM}({iteration} tool calls, {int(total)}s total){RESET}")


# --- Main ---

# All config comes from environment variables (set via GitHub secrets/workflow)
MODEL_ID = os.environ.get("HARNESS_MODEL_ID", "us.anthropic.claude-opus-4-7")
HARNESS_ARN = os.environ.get("HARNESS_ARN", "")
PR_URL = os.environ.get("PR_URL", "")

for name, val in [("HARNESS_ARN", HARNESS_ARN), ("PR_URL", PR_URL)]:
    if not val:
        print(f"{RED}ERROR: {name} environment variable is required{RESET}", file=sys.stderr)
        sys.exit(1)

# Extract region from the ARN (arn:aws:bedrock-agentcore:{region}:{account}:harness/{id})
REGION = HARNESS_ARN.split(":")[3]
SESSION_ID = str(uuid.uuid4()).upper()

print(f"{CYAN}Session:{RESET} {SESSION_ID}")
print(f"{CYAN}PR:{RESET}      {PR_URL}")
print(f"{CYAN}Harness:{RESET} {HARNESS_ARN}")
print()

SYSTEM_PROMPT = read_prompt("system.md")
REVIEW_PROMPT = read_prompt("review.md").format(pr_url=PR_URL)

messages = [{"role": "user", "content": [{"text": REVIEW_PROMPT}]}]

event_stream = invoke_harness_streaming(
    HARNESS_ARN, SESSION_ID, SYSTEM_PROMPT, messages, MODEL_ID, REGION
)

print_stream(event_stream)
