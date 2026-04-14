#!/usr/bin/env python3
"""Setup: Memory with multiple strategies and tags.

Tests: memory import with SEMANTIC, SUMMARIZATION, USER_PREFERENCE strategies,
       tags, eventExpiryDuration, executionRoleArn.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import time
from common import (
    ensure_role, get_control_client, wait_for_memory,
    save_resource, print_import_command, tag_resource,
)


def main():
    role_arn = ensure_role()
    client = get_control_client()
    memory_name = f"bugbash_memory_{int(time.time())}"

    print(f"Creating memory: {memory_name}")
    resp = client.create_memory(
        name=memory_name,
        clientToken=f"bugbash-{int(time.time())}",
        eventExpiryDuration=30,
        memoryExecutionRoleArn=role_arn,
        memoryStrategies=[
            {
                "semanticMemoryStrategy": {
                    "name": "bugbash_semantic",
                    "description": "Semantic strategy for bugbash testing",
                    "namespaces": ["default"],
                }
            },
            {
                "summaryMemoryStrategy": {
                    "name": "bugbash_summary",
                    "description": "Summary strategy for bugbash testing",
                }
            },
            {
                "userPreferenceMemoryStrategy": {
                    "name": "bugbash_userpref",
                    "description": "User preference strategy for bugbash testing",
                }
            },
        ],
    )

    memory_id = resp["memory"]["id"]
    memory_arn = resp["memory"]["arn"]
    print(f"Memory ID: {memory_id}")
    print(f"Memory ARN: {memory_arn}")

    tag_resource(client, memory_arn, {
        "env": "bugbash",
        "team": "agentcore-cli",
    })

    save_resource("memory-full", memory_arn, memory_id)
    if not wait_for_memory(client, memory_id):
        sys.exit(1)

    print()
    print("Expected fields after import:")
    print(f"  eventExpiryDuration: 30")
    print(f"  executionRoleArn: {role_arn}")
    print("  strategies:")
    print("    - type: SEMANTIC, name: bugbash_semantic, namespaces: [default]")
    print("    - type: SUMMARIZATION, name: bugbash_summary")
    print("    - type: USER_PREFERENCE, name: bugbash_userpref")
    print("  tags: {env: bugbash, team: agentcore-cli}")

    print_import_command("memory", memory_arn)


if __name__ == "__main__":
    main()
