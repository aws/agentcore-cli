#!/usr/bin/env python3
"""Delete all resources tracked in bugbash-resources.json.

Called from afterAll in import e2e tests as a fallback cleanup
for resources that were not successfully imported into CloudFormation.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RESOURCES_FILE, get_control_client


def main():
    if not os.path.exists(RESOURCES_FILE):
        print("No bugbash-resources.json found, nothing to clean up")
        return

    with open(RESOURCES_FILE) as f:
        resources = json.load(f)

    client = get_control_client()

    for key, val in resources.items():
        rid = val.get("id")
        if not rid:
            continue
        try:
            if "runtime" in key:
                client.delete_agent_runtime(agentRuntimeId=rid)
            elif "memory" in key:
                client.delete_memory(memoryId=rid)
            elif "evaluator" in key:
                client.delete_evaluator(evaluatorId=rid)
            print(f"Deleted {key}: {rid}")
        except Exception as e:
            print(f"Could not delete {key} ({rid}): {e}")

    os.remove(RESOURCES_FILE)
    print("Cleaned up bugbash-resources.json")


if __name__ == "__main__":
    main()
