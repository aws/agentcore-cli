"""Invoke Bedrock AgentCore Harness to review a GitHub PR.

Reads PR_URL from the environment. Streams harness output to stdout.
Requires the local service model in .github/scripts/models/ because
InvokeHarness is not yet in standard boto3.
"""

import json
import os
import sys
import time
import uuid

import boto3
from botocore.config import Config as BotoConfig
from botocore.loaders import Loader

from harness_config import REGION, MODEL_ID, harness_arn

# ANSI color codes
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

PR_URL = os.environ.get("PR_URL")
if not PR_URL:
    print(f"{RED}ERROR: PR_URL environment variable is required{RESET}", file=sys.stderr)
    sys.exit(1)

HARNESS_ARN = harness_arn()
SESSION_ID = str(uuid.uuid4()).upper()

print(f"{CYAN}Session:{RESET} {SESSION_ID}")
print(f"{CYAN}PR:{RESET}      {PR_URL}")
print(f"{CYAN}Harness:{RESET} {HARNESS_ARN}")
print()

# Register the local data plane model with Boto3
model_dir = os.path.join(os.path.dirname(__file__), "..", "models")
loader = Loader()
loader.search_paths.insert(0, model_dir)
session = boto3.Session(region_name=REGION)
session._session.register_component("data_loader", loader)

client = session.client(
    "bedrock-agentcore",
    config=BotoConfig(
        read_timeout=600,
        connect_timeout=10,
        retries={"max_attempts": 0},
    ),
)

SYSTEM_PROMPT = """# AgentCore CLI Development Workspace

This workspace contains two repos for developing and testing the AgentCore CLI.

## Repositories

### agentcore-cli/ (`aws/agentcore-cli`)

The terminal experience for creating, developing, and deploying AI agents to AgentCore. Node.js/TypeScript CLI built with Ink (React-based TUI).

### agentcore-l3-cdk-constructs/ (`aws/agentcore-l3-cdk-constructs`)

AWS CDK L3 constructs for declaring and deploying AgentCore infrastructure. Used by agentcore-cli to vend CDK projects when users run `agentcore create`.

## How they relate

`agentcore-cli` is the main product. It vends CDK projects using constructs from `agentcore-l3-cdk-constructs`.

## Testing with a bundled distribution

Run `npm run bundle` in `agentcore-cli/` to create a tar distribution that includes the packaged `agentcore-l3-cdk-constructs`. You can then install it globally with `npm install -g <path-to-tar>` to test the CLI end-to-end.
"""

REVIEW_PROMPT = f"""Review this GitHub PR: {PR_URL}

You have tools to fetch the PR diff, read files, search the web, and post comments on the PR.

You have these repos cloned locally for context:
- /opt/workspace/agentcore-cli — aws/agentcore-cli
- /opt/workspace/agentcore-l3-cdk-constructs — aws/agentcore-l3-cdk-constructs

Before reviewing, read all existing comments on the PR to understand what has already been discussed. Do not repeat or re-post issues that have already been raised in existing comments.

Review the PR. If there are any serious issues that require code changes before merging, post a comment on the PR for each issue explaining the problem. If there are multiple ways to fix an issue, list the options so the author can choose. Skip style nits and minor suggestions — only flag things that actually need to change.

If all serious issues have already been raised in existing comments, or if you found no new issues, post a single comment on the PR saying it looks good to merge (or that all issues have already been flagged).
"""

response = client.invoke_harness(
    harnessArn=HARNESS_ARN,
    runtimeSessionId=SESSION_ID,
    systemPrompt=[{"text": SYSTEM_PROMPT}],
    messages=[
        {
            "role": "user",
            "content": [{"text": REVIEW_PROMPT}],
        }
    ],
    model={
        "bedrockModelConfig": {
            "modelId": MODEL_ID,
        }
    },
)

# Stream event handling
start_time = time.time()
iteration = 0
current_tool_name = None
current_tool_input = ""
tool_start_time = 0.0
in_tool_group = False
had_text_output = False

for event in response["stream"]:
    if "contentBlockStart" in event:
        start = event["contentBlockStart"].get("start", {})
        if "toolUse" in start:
            current_tool_name = start["toolUse"].get("name", "unknown")
            current_tool_input = ""
            tool_start_time = time.time()
            iteration += 1

    elif "contentBlockDelta" in event:
        delta = event["contentBlockDelta"].get("delta", {})
        if "text" in delta:
            # Close tool group before printing reasoning text
            if in_tool_group:
                print("::endgroup::", flush=True)
                in_tool_group = False
                print(flush=True)
            print(f"{DIM}{delta['text']}{RESET}", end="", flush=True)
            had_text_output = True
        if "toolUse" in delta:
            current_tool_input += delta["toolUse"].get("input", "")

    elif "contentBlockStop" in event:
        if current_tool_name:
            elapsed = time.time() - tool_start_time
            try:
                parsed = json.loads(current_tool_input)
            except (json.JSONDecodeError, TypeError):
                parsed = current_tool_input

            # Close previous tool group if open
            if in_tool_group:
                print("::endgroup::", flush=True)
                in_tool_group = False

            # Add spacing after reasoning text
            if had_text_output:
                print("\n", flush=True)
                had_text_output = False

            # Format tool call header
            if isinstance(parsed, dict) and "command" in parsed:
                header = f"{CYAN}[{iteration}]{RESET} {YELLOW}{current_tool_name}{RESET} {DIM}({elapsed:.1f}s){RESET}: $ {parsed['command']}"
            else:
                header = f"{CYAN}[{iteration}]{RESET} {YELLOW}{current_tool_name}{RESET} {DIM}({elapsed:.1f}s){RESET}"

            print(f"::group::{header}", flush=True)
            in_tool_group = True

            # Print tool input details inside the group
            if isinstance(parsed, dict):
                for k, v in parsed.items():
                    if k == "command":
                        continue
                    v_str = str(v)[:300]
                    print(f"  {DIM}{k}:{RESET} {v_str}", flush=True)

        current_tool_name = None
        current_tool_input = ""

    elif "messageStop" in event:
        if in_tool_group:
            print("::endgroup::", flush=True)
            in_tool_group = False
        reason = event["messageStop"].get("stopReason", "")
        if reason == "end_turn":
            total = time.time() - start_time
            minutes = int(total // 60)
            seconds = int(total % 60)
            print(f"\n\n{GREEN}{'=' * 50}", flush=True)
            print(f"  Done ({minutes}m {seconds}s)", flush=True)
            print(f"{'=' * 50}{RESET}", flush=True)

    elif "internalServerException" in event:
        if in_tool_group:
            print("::endgroup::", flush=True)
        print(f"\n{RED}ERROR: {event['internalServerException']}{RESET}", file=sys.stderr)
        sys.exit(1)

if in_tool_group:
    print("::endgroup::", flush=True)

total = time.time() - start_time
print(f"\n{GREEN}Review complete.{RESET} {DIM}({iteration} tool calls, {int(total)}s total){RESET}")
