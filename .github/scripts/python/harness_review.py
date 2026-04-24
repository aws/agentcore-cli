"""Invoke Bedrock AgentCore Harness to review a GitHub PR.

Reads PR_URL from the environment. Streams harness output to stdout.
Uses raw HTTP with SigV4 signing — no custom service model needed.
"""

import json
import os
import sys
import time
import uuid

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.eventstream import EventStreamBuffer
from urllib.parse import quote
import urllib3

# ANSI color codes
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")


def read_prompt(filename):
    """Read a prompt template from the prompts directory."""
    path = os.path.join(SCRIPTS_DIR, "prompts", filename)
    with open(path) as f:
        return f.read()


def invoke_harness(harness_arn, body, region):
    """Send a SigV4-signed request to the harness invoke endpoint. Returns a streaming response.

    InvokeHarness is not in standard boto3, so we call the REST API directly.
    boto3 is only used to resolve AWS credentials (from env vars, OIDC, etc.)
    and sign the request with SigV4. The response is an AWS binary event stream.
    """
    session = boto3.Session(region_name=region)
    credentials = session.get_credentials().get_frozen_credentials()
    url = f"https://bedrock-agentcore.{region}.amazonaws.com/harnesses/invoke?harnessArn={quote(harness_arn, safe='')}"
    request = AWSRequest(method="POST", url=url, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/vnd.amazon.eventstream",
    })
    SigV4Auth(credentials, "bedrock-agentcore", region).add_auth(request)
    return urllib3.PoolManager().urlopen(
        "POST", url, body=body,
        headers=dict(request.headers),
        preload_content=False,
        timeout=urllib3.Timeout(connect=10, read=600),
    )


def parse_events(http_response):
    """Yield (event_type, payload) tuples from the harness binary event stream.

    The response arrives as raw bytes in AWS binary event stream format.
    EventStreamBuffer reassembles complete events from the 4KB chunks,
    and we decode each event's JSON payload before yielding it.
    """
    event_buffer = EventStreamBuffer()
    for chunk in http_response.stream(4096):
        event_buffer.add_data(chunk)
        for event in event_buffer:
            if event.headers.get(":message-type") == "exception":
                payload = json.loads(event.payload.decode("utf-8"))
                print(f"\n{RED}ERROR: {payload}{RESET}", file=sys.stderr)
                sys.exit(1)
            event_type = event.headers.get(":event-type", "")
            if event.payload:
                yield event_type, json.loads(event.payload.decode("utf-8"))


def print_stream(http_response):
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

    for event_type, payload in parse_events(http_response):

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

request_body = json.dumps({
    "runtimeSessionId": SESSION_ID,
    "systemPrompt": [{"text": SYSTEM_PROMPT}],
    "messages": [{"role": "user", "content": [{"text": REVIEW_PROMPT}]}],
    "model": {"bedrockModelConfig": {"modelId": MODEL_ID}},
})

http_response = invoke_harness(HARNESS_ARN, request_body, REGION)

if http_response.status != 200:
    error = http_response.read().decode("utf-8")
    print(f"{RED}ERROR: HTTP {http_response.status}: {error}{RESET}", file=sys.stderr)
    sys.exit(1)

print_stream(http_response)
