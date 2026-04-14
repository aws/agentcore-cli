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

    failed = []
    for key, val in resources.items():
        rid = val.get("id")
        if not rid:
            continue
        # Gateway targets are deleted automatically when the parent gateway is deleted
        if "gateway" in key and "target" in key:
            print(f"Skipping {key} (deleted with parent gateway)")
            continue
        try:
            if "runtime" in key:
                client.delete_agent_runtime(agentRuntimeId=rid)
            elif "memory" in key:
                client.delete_memory(memoryId=rid)
            elif "evaluator" in key:
                client.delete_evaluator(evaluatorId=rid)
            elif "gateway" in key:
                client.delete_gateway(gatewayIdentifier=rid)
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
