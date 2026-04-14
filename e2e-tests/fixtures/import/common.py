"""Shared helpers for bugbash setup scripts."""
import json
import os
import time
import zipfile
import tempfile

import boto3

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(SCRIPT_DIR, "app")
RESOURCES_FILE = os.path.join(SCRIPT_DIR, "bugbash-resources.json")
INLINE_POLICY_NAME = "bugbash-agentcore-permissions"


def get_code_bucket():
    """Return the code bucket name, creating it if needed."""
    account_id = get_account_id()
    bucket_name = f"bugbash-agentcore-code-{account_id}-{REGION}"
    s3 = boto3.client("s3", region_name=REGION)
    try:
        s3.head_bucket(Bucket=bucket_name)
        print(f"S3 bucket already exists: {bucket_name}")
    except s3.exceptions.ClientError:
        print(f"Creating S3 bucket: {bucket_name}")
        create_args = {"Bucket": bucket_name}
        if REGION != "us-east-1":
            create_args["CreateBucketConfiguration"] = {"LocationConstraint": REGION}
        s3.create_bucket(**create_args)
    return bucket_name


def upload_code(prefix="bugbash"):
    """Zip APP_DIR and upload to S3. Returns (bucket, s3_key)."""
    bucket_name = get_code_bucket()
    s3 = boto3.client("s3", region_name=REGION)

    # Create zip of app directory
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(APP_DIR):
                for f in files:
                    if f == "Dockerfile":
                        continue
                    full = os.path.join(root, f)
                    arcname = os.path.relpath(full, APP_DIR)
                    zf.write(full, arcname)

        s3_key = f"{prefix}/code.zip"
        print(f"Uploading code to s3://{bucket_name}/{s3_key}")
        s3.upload_file(tmp_path, bucket_name, s3_key)
        print("Upload complete")
        return bucket_name, s3_key
    finally:
        os.unlink(tmp_path)


def get_account_id():
    sts = boto3.client("sts", region_name=REGION)
    return sts.get_caller_identity()["Account"]


def get_control_client():
    return boto3.client("bedrock-agentcore-control", region_name=REGION)


def ensure_role():
    """Create the bugbash IAM role if it doesn't exist, with all needed permissions.

    This role is intentionally persistent across test runs — ensure_role() is
    idempotent (create-if-not-exists) so multiple CI jobs and local debugging
    sessions share the same role without conflicts.
    """
    account_id = get_account_id()
    role_name = "bugbash-agentcore-role"
    role_arn = f"arn:aws:iam::{account_id}:role/{role_name}"
    bucket_name = f"bugbash-agentcore-code-{account_id}-{REGION}"

    iam = boto3.client("iam")
    created = False
    try:
        iam.get_role(RoleName=role_name)
        print(f"IAM role already exists: {role_arn}")
    except iam.exceptions.NoSuchEntityException:
        print(f"Creating IAM role: {role_name}")
        try:
            iam.create_role(
                RoleName=role_name,
                AssumeRolePolicyDocument=json.dumps({
                    "Version": "2012-10-17",
                    "Statement": [{
                        "Effect": "Allow",
                        "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
                        "Action": "sts:AssumeRole",
                    }],
                }),
            )
            created = True
        except iam.exceptions.EntityAlreadyExistsException:
            print("Role was created by another process, waiting for propagation...")
            created = True

    # Attach managed policies
    managed_policies = [
        "arn:aws:iam::aws:policy/AmazonBedrockFullAccess",
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess",
        "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    ]
    for policy_arn in managed_policies:
        try:
            iam.attach_role_policy(RoleName=role_name, PolicyArn=policy_arn)
        except Exception:
            pass  # Already attached

    # Add inline policy for S3 code bucket and ECR auth
    inline_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
                "Resource": [
                    f"arn:aws:s3:::{bucket_name}",
                    f"arn:aws:s3:::{bucket_name}/*",
                ],
            },
            {
                "Effect": "Allow",
                "Action": [
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage",
                    "ecr:GetAuthorizationToken",
                ],
                "Resource": "*",
            },
            {
                "Effect": "Allow",
                "Action": [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                ],
                "Resource": "*",
            },
        ],
    }
    try:
        iam.put_role_policy(
            RoleName=role_name,
            PolicyName=INLINE_POLICY_NAME,
            PolicyDocument=json.dumps(inline_policy),
        )
        print("Inline permissions policy attached")
    except Exception as e:
        print(f"Warning: could not attach inline policy: {e}")

    if created:
        print("Waiting 10s for role propagation...")
        time.sleep(10)

    return role_arn


def wait_for_runtime(client, runtime_id, timeout=300):
    """Wait for a runtime to reach READY status."""
    print(f"Waiting for runtime {runtime_id} to become READY...")
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get_agent_runtime(agentRuntimeId=runtime_id)
        status = resp.get("status", "UNKNOWN")
        if status == "READY":
            print(f"Runtime {runtime_id} is READY")
            return True
        if status in ("CREATE_FAILED", "UPDATE_FAILED", "FAILED"):
            print(f"ERROR: Runtime {runtime_id} status: {status}")
            return False
        elapsed = int(time.time() - start)
        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(5)
    print(f"WARNING: Runtime did not reach READY after {timeout}s")
    return False


def wait_for_memory(client, memory_id, timeout=300):
    """Wait for a memory to reach ACTIVE status."""
    print(f"Waiting for memory {memory_id} to become ACTIVE...")
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get_memory(memoryId=memory_id)
        status = resp.get("memory", {}).get("status", "UNKNOWN")
        if status == "ACTIVE":
            print(f"Memory {memory_id} is ACTIVE")
            return True
        elapsed = int(time.time() - start)
        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(5)
    print(f"WARNING: Memory did not reach ACTIVE after {timeout}s")
    return False


def wait_for_evaluator(client, evaluator_id, timeout=120):
    """Wait for an evaluator to reach ACTIVE status."""
    print(f"Waiting for evaluator {evaluator_id} to become ACTIVE...")
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get_evaluator(evaluatorId=evaluator_id)
        status = resp.get("status", "UNKNOWN")
        if status == "ACTIVE":
            print(f"Evaluator {evaluator_id} is ACTIVE")
            return True
        if status in ("CREATE_FAILED", "FAILED"):
            print(f"ERROR: Evaluator {evaluator_id} status: {status}")
            return False
        elapsed = int(time.time() - start)
        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(5)
    print(f"WARNING: Evaluator did not reach ACTIVE after {timeout}s")
    return False


def save_resource(key, arn, resource_id):
    """Save a resource entry to bugbash-resources.json."""
    resources = {}
    if os.path.exists(RESOURCES_FILE):
        with open(RESOURCES_FILE) as f:
            resources = json.load(f)
    resources[key] = {"arn": arn, "id": resource_id}
    with open(RESOURCES_FILE, "w") as f:
        json.dump(resources, f, indent=2)
    print(f"Saved {key} to {RESOURCES_FILE}")


def print_import_command(resource_type, arn, extra_flags=""):
    """Print the agentcore import command for the tester."""
    print()
    print("=" * 50)
    print("To test import, run (from an agentcore project directory):")
    print()
    print(f"  export AWS_REGION={REGION}")
    if resource_type == "runtime":
        print(f"  agentcore import runtime --arn {arn} --code {APP_DIR} {extra_flags}")
    elif resource_type == "evaluator":
        print(f"  agentcore import evaluator --arn {arn} {extra_flags}")
    else:
        print(f"  agentcore import memory --arn {arn} {extra_flags}")
    print()
    print("NOTE: The project must have aws-targets.json with a target for the same region.")
    print("=" * 50)
    print()


def tag_resource(client, arn, tags):
    """Tag a resource via the control plane API."""
    print(f"Tagging resource with {tags}...")
    client.tag_resource(resourceArn=arn, tags=tags)


def wait_for_gateway(client, gateway_id, timeout=120):
    """Wait for a gateway to reach READY status."""
    print(f"Waiting for gateway {gateway_id} to become READY...")
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get_gateway(gatewayIdentifier=gateway_id)
        status = resp.get("status", "UNKNOWN")
        if status == "READY":
            print(f"Gateway {gateway_id} is READY")
            return True
        if status in ("CREATE_FAILED", "FAILED"):
            reason = resp.get("statusReasons", [{}])
            print(f"ERROR: Gateway {gateway_id} status: {status} — {reason}")
            return False
        elapsed = int(time.time() - start)
        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(5)
    print(f"WARNING: Gateway did not reach READY after {timeout}s")
    return False


def wait_for_gateway_target(client, gateway_id, target_id, timeout=120):
    """Wait for a gateway target to reach READY status."""
    print(f"Waiting for target {target_id} to become READY...")
    start = time.time()
    while time.time() - start < timeout:
        resp = client.get_gateway_target(
            gatewayIdentifier=gateway_id,
            targetId=target_id,
        )
        status = resp.get("status", "UNKNOWN")
        if status == "READY":
            print(f"Target {target_id} is READY")
            return True
        if status in ("CREATE_FAILED", "FAILED"):
            reason = resp.get("statusReasons", [{}])
            print(f"ERROR: Target {target_id} status: {status} — {reason}")
            return False
        elapsed = int(time.time() - start)
        print(f"  Status: {status} ({elapsed}s elapsed)")
        time.sleep(5)
    print(f"WARNING: Target did not reach READY after {timeout}s")
    return False
