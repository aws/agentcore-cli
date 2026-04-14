#!/usr/bin/env python3
"""Setup: Bare minimum CodeZip runtime (PUBLIC, HTTP, basic entrypoint).

Tests: baseline import, entrypoint detection, CodeZip build type, executionRoleArn.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import time
from common import (
    ensure_role, get_control_client, wait_for_runtime,
    save_resource, print_import_command, upload_code,
)


def main():
    role_arn = ensure_role()
    client = get_control_client()
    ts = int(time.time())
    runtime_name = f"bugbash_basic_{ts}"

    bucket, s3_key = upload_code(f"bugbash-basic-{ts}")

    print(f"Creating basic runtime: {runtime_name}")
    resp = client.create_agent_runtime(
        agentRuntimeName=runtime_name,
        roleArn=role_arn,
        networkConfiguration={"networkMode": "PUBLIC"},
        agentRuntimeArtifact={
            "codeConfiguration": {
                "code": {
                    "s3": {
                        "bucket": bucket,
                        "prefix": s3_key,
                    }
                },
                "runtime": "PYTHON_3_12",
                "entryPoint": ["main.py"],
            }
        },
        protocolConfiguration={"serverProtocol": "HTTP"},
    )

    runtime_id = resp["agentRuntimeId"]
    runtime_arn = resp["agentRuntimeArn"]
    print(f"Runtime ID: {runtime_id}")
    print(f"Runtime ARN: {runtime_arn}")

    save_resource("runtime-basic", runtime_arn, runtime_id)
    if not wait_for_runtime(client, runtime_id):
        sys.exit(1)

    print()
    print("Expected fields after import:")
    print("  build: CodeZip")
    print("  entrypoint: main.py")
    print("  runtimeVersion: PYTHON_3_12")
    print("  protocol: HTTP")
    print("  networkMode: PUBLIC")
    print(f"  executionRoleArn: {role_arn}")
    print("  lifecycleConfiguration: defaults (idleRuntimeSessionTimeout=900, maxLifetime=28800)")
    print("  (no envVars, tags, or requestHeaderAllowlist)")

    print_import_command("runtime", runtime_arn)


if __name__ == "__main__":
    main()
