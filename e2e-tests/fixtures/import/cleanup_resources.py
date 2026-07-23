#!/usr/bin/env python3
"""Delete all resources tracked in bugbash-resources.json.

Called from afterAll in import e2e tests as a fallback cleanup
for resources that were not successfully imported into CloudFormation.

Note: The IAM role (bugbash-agentcore-role) is intentionally left in place —
it is shared across test runs via ensure_role() in common.py.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import REGION, RESOURCES_FILE, get_control_client, get_account_id

import boto3


def cleanup_s3_code_objects():
    """Delete uploaded code.zip objects from the bugbash S3 bucket."""
    account_id = get_account_id()
    bucket_name = f"bugbash-agentcore-code-{account_id}-{REGION}"
    s3 = boto3.client("s3", region_name=REGION)
    try:
        resp = s3.list_objects_v2(Bucket=bucket_name)
        objects = resp.get("Contents", [])
        if not objects:
            return
        s3.delete_objects(
            Bucket=bucket_name,
            Delete={"Objects": [{"Key": o["Key"]} for o in objects]},
        )
        print(f"Deleted {len(objects)} object(s) from s3://{bucket_name}")
    except Exception as e:
        print(f"Could not clean up S3 objects: {e}")


def main():
    if not os.path.exists(RESOURCES_FILE):
        print("No bugbash-resources.json found, nothing to clean up")
        return

    with open(RESOURCES_FILE) as f:
        resources = json.load(f)

    client = get_control_client()

    # A gateway can only be deleted after its targets, and a target delete needs
    # the parent gateway's id. Resolve the gateway id up front and order deletes:
    # targets first, then other resources, then the gateway last.
    gateway_id = next(
        (v.get("id") for k, v in resources.items() if k == "gateway"), None
    )

    def delete_order(item):
        key = item[0]
        if "gateway-target" in key:
            return 0
        if key == "gateway":
            return 2
        return 1

    failed = []
    for key, val in sorted(resources.items(), key=delete_order):
        rid = val.get("id")
        if not rid:
            continue
        try:
            if "gateway-target" in key:
                # Targets must be deleted before the gateway they belong to.
                client.delete_gateway_target(gatewayIdentifier=gateway_id, targetId=rid)
            elif key == "gateway":
                client.delete_gateway(gatewayIdentifier=rid)
            elif "runtime" in key:
                client.delete_agent_runtime(agentRuntimeId=rid)
            elif "memory" in key:
                client.delete_memory(memoryId=rid)
            elif "evaluator" in key:
                client.delete_evaluator(evaluatorId=rid)
            print(f"Deleted {key}: {rid}")
        except Exception as e:
            print(f"Could not delete {key} ({rid}): {e}")
            failed.append(key)

    if failed:
        remaining = {k: v for k, v in resources.items() if k in failed}
        with open(RESOURCES_FILE, "w") as f:
            json.dump(remaining, f, indent=2)
        print(f"WARNING: {len(failed)} resources could not be deleted, kept in {RESOURCES_FILE}")
    else:
        os.remove(RESOURCES_FILE)
        print("Cleaned up bugbash-resources.json")

    cleanup_s3_code_objects()


if __name__ == "__main__":
    main()
