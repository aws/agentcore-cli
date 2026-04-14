#!/usr/bin/env python3
"""Setup: LLM-as-a-Judge evaluator with rating scale and tags.

Tests: evaluator import, level detection, llmAsAJudge config, rating scale,
       model config, tags.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import time
from common import (
    get_control_client, save_resource, tag_resource,
    wait_for_evaluator, print_import_command,
)

DEFAULT_EVALUATOR_MODEL = os.environ.get("DEFAULT_EVALUATOR_MODEL", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")


def main():
    client = get_control_client()
    ts = int(time.time())
    evaluator_name = f"bugbash_eval_{ts}"

    print(f"Creating evaluator: {evaluator_name}")
    resp = client.create_evaluator(
        evaluatorName=evaluator_name,
        description="Bugbash evaluator for import testing",
        level="SESSION",
        evaluatorConfig={
            "llmAsAJudge": {
                "instructions": (
                    "Evaluate the quality of the agent's response in this session.\n"
                    "Consider the following criteria:\n"
                    "1. Did the agent answer the user's question? ({context})\n"
                    "2. Was the response accurate and helpful?\n"
                    "3. Was the response well-structured?"
                ),
                "ratingScale": {
                    "numerical": [
                        {"value": 1, "label": "Poor", "definition": "Response is irrelevant or incorrect"},
                        {"value": 2, "label": "Fair", "definition": "Response is partially correct but missing key information"},
                        {"value": 3, "label": "Good", "definition": "Response is correct and addresses the question"},
                        {"value": 4, "label": "Very Good", "definition": "Response is thorough and well-structured"},
                        {"value": 5, "label": "Excellent", "definition": "Response is comprehensive, accurate, and exceptionally helpful"},
                    ],
                },
                "modelConfig": {
                    "bedrockEvaluatorModelConfig": {
                        "modelId": DEFAULT_EVALUATOR_MODEL,
                    }
                },
            }
        },
    )

    evaluator_id = resp["evaluatorId"]
    evaluator_arn = resp["evaluatorArn"]
    print(f"Evaluator ID: {evaluator_id}")
    print(f"Evaluator ARN: {evaluator_arn}")

    tag_resource(client, evaluator_arn, {
        "env": "bugbash",
        "team": "agentcore-cli",
    })

    save_resource("evaluator-llm", evaluator_arn, evaluator_id)
    if not wait_for_evaluator(client, evaluator_id):
        sys.exit(1)

    print()
    print("Expected fields after import:")
    print(f"  name: {evaluator_name}")
    print("  level: SESSION")
    print("  description: Bugbash evaluator for import testing")
    print(f"  config.llmAsAJudge.model: {DEFAULT_EVALUATOR_MODEL}")
    print("  config.llmAsAJudge.instructions: (multi-line with {context} placeholder)")
    print("  config.llmAsAJudge.ratingScale: numerical 1-5 (Poor to Excellent)")
    print("  tags: {env: bugbash, team: agentcore-cli}")

    print_import_command("evaluator", evaluator_arn)


if __name__ == "__main__":
    main()
