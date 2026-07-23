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
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import REGION, RESOURCES_FILE, get_control_client, get_account_id

import boto3

DELETE_TIMEOUT_SECONDS = 120
DELETE_POLL_SECONDS = 5


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


def is_not_found(error):
    """Return whether an AWS SDK error means the resource is already gone."""
    response = getattr(error, "response", {})
    code = response.get("Error", {}).get("Code")
    return code in ("ResourceNotFoundException", "NotFoundException")


def wait_for_gateway_target_deleted(
    client,
    gateway_id,
    target_id,
    timeout=DELETE_TIMEOUT_SECONDS,
    poll_interval=DELETE_POLL_SECONDS,
):
    """Wait until a target is gone so its parent gateway can be deleted."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            client.get_gateway_target(
                gatewayIdentifier=gateway_id,
                targetId=target_id,
            )
        except Exception as e:
            if is_not_found(e):
                return
            raise
        time.sleep(poll_interval)
    raise TimeoutError(f"Gateway target {target_id} was not deleted within {timeout}s")


def delete_tracked_resources(client, resources):
    """Delete tracked resources and return keys that still require cleanup."""
    gateways_by_arn = {
        value.get("arn"): value.get("id")
        for key, value in resources.items()
        if key == "gateway"
    }

    def delete_order(item):
        key = item[0]
        if key.startswith("gateway-target"):
            return 0
        if key == "gateway":
            return 2
        return 1

    failed = []
    for key, value in sorted(resources.items(), key=delete_order):
        resource_id = value.get("id")
        if not resource_id:
            print(f"Could not delete {key}: tracked resource has no id")
            failed.append(key)
            continue

        try:
            if key.startswith("gateway-target"):
                gateway_id = gateways_by_arn.get(value.get("arn"))
                if not gateway_id:
                    raise ValueError("tracked gateway target has no matching parent gateway")
                client.delete_gateway_target(
                    gatewayIdentifier=gateway_id,
                    targetId=resource_id,
                )
                wait_for_gateway_target_deleted(client, gateway_id, resource_id)
            elif key == "gateway":
                client.delete_gateway(gatewayIdentifier=resource_id)
            elif key.startswith("runtime-"):
                client.delete_agent_runtime(agentRuntimeId=resource_id)
            elif key.startswith("memory-"):
                client.delete_memory(memoryId=resource_id)
            elif key.startswith("evaluator-"):
                client.delete_evaluator(evaluatorId=resource_id)
            else:
                raise ValueError(f"unsupported tracked resource key: {key}")
            print(f"Deleted {key}: {resource_id}")
        except Exception as e:
            if is_not_found(e):
                print(f"Already deleted {key}: {resource_id}")
                continue
            print(f"Could not delete {key} ({resource_id}): {e}")
            failed.append(key)

    return failed


def main():
    if not os.path.exists(RESOURCES_FILE):
        print("No bugbash-resources.json found, nothing to clean up")
        return

    with open(RESOURCES_FILE) as f:
        resources = json.load(f)

    client = get_control_client()
    failed = delete_tracked_resources(client, resources)

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
