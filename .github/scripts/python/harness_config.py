"""Shared configuration for harness invocation.

All sensitive values come from environment variables (set via GitHub secrets).
"""

import os
import sys

REGION = os.environ.get("HARNESS_REGION", "us-east-1")
ACCOUNT_ID = os.environ.get("HARNESS_ACCOUNT_ID", "")
MODEL_ID = os.environ.get("HARNESS_MODEL_ID", "us.anthropic.claude-opus-4-7")
HARNESS_ID = os.environ.get("HARNESS_ID", "")

if not ACCOUNT_ID:
    print("ERROR: HARNESS_ACCOUNT_ID environment variable is required", file=sys.stderr)
    sys.exit(1)

if not HARNESS_ID:
    print("ERROR: HARNESS_ID environment variable is required", file=sys.stderr)
    sys.exit(1)


def harness_arn(harness_id=HARNESS_ID):
    """Build a harness ARN from an ID."""
    return f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT_ID}:harness/{harness_id}"
