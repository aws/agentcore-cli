#!/usr/bin/env python3
"""Idempotently create the external AWS resources that some gateway targets need.

Some gateway-target types reference AWS resources that must already exist before
`agentcore deploy` can wire them up:

  - lambda-function-arn  →  an existing Lambda function ARN
  - api-gateway          →  an existing API Gateway REST API id + stage

This script checks for each resource and creates it only if missing (so repeated
e2e runs reuse the same resources — no leaks, no per-run cost). It writes the
identifiers to gateway-target-prereqs-<suffix>.json for the test to read.

Run:  uv run --with boto3 python3 setup_target_prereqs.py
Env:  AWS_REGION, RESOURCE_SUFFIX (optional; defaults to a random hex)
"""
import io
import json
import os
import time
import uuid
import zipfile

import boto3
import botocore

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
SUFFIX = os.environ.get("RESOURCE_SUFFIX") or uuid.uuid4().hex[:12]
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(SCRIPT_DIR, f"gateway-target-prereqs-{SUFFIX}.json")

# Resource names are deterministic + account-scoped so runs reuse them (idempotent).
LAMBDA_ROLE_NAME = "e2e-gwtarget-lambda-role"
LAMBDA_FN_NAME = "e2e-gwtarget-fn"
# v2: the REST API method now carries an operationName (→ operationId in the
# OpenAPI export) which the AgentCore api-gateway target requires.
REST_API_NAME = "e2e-gwtarget-api-v2"
REST_API_STAGE = "prod"


def account_id():
    return boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]


def ensure_lambda_role():
    """Create (or reuse) a basic Lambda execution role."""
    iam = boto3.client("iam")
    arn = f"arn:aws:iam::{account_id()}:role/{LAMBDA_ROLE_NAME}"
    try:
        iam.get_role(RoleName=LAMBDA_ROLE_NAME)
        print(f"Lambda role exists: {arn}")
        return arn
    except iam.exceptions.NoSuchEntityException:
        pass
    print(f"Creating Lambda role: {LAMBDA_ROLE_NAME}")
    iam.create_role(
        RoleName=LAMBDA_ROLE_NAME,
        AssumeRolePolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }],
        }),
    )
    iam.attach_role_policy(
        RoleName=LAMBDA_ROLE_NAME,
        PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    )
    print("Waiting 10s for role propagation...")
    time.sleep(10)
    return arn


def _lambda_zip():
    """A trivial handler — the gateway only needs a callable function to exist."""
    src = (
        "def handler(event, context):\n"
        "    name = (event or {}).get('name', 'world')\n"
        "    return {'message': f'hello {name}'}\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("lambda_function.py", src)
    return buf.getvalue()


def grant_agentcore_invoke(lam, arn):
    """Resource-based policy so the AgentCore gateway service can invoke the function.

    The CDK grants lambda:InvokeFunction to the gateway role too, but that
    identity-based policy can lose a propagation race against gateway-target
    validation. A resource-based policy is an independent, account-scoped
    authorization path. Idempotent (ignore an existing statement id)."""
    try:
        lam.add_permission(
            FunctionName=LAMBDA_FN_NAME,
            StatementId="agentcore-gateway-invoke",
            Action="lambda:InvokeFunction",
            Principal="bedrock-agentcore.amazonaws.com",
            SourceAccount=account_id(),
        )
        print("Added AgentCore invoke permission to Lambda")
    except lam.exceptions.ResourceConflictException:
        print("AgentCore invoke permission already present")


def ensure_lambda():
    lam = boto3.client("lambda", region_name=REGION)
    try:
        resp = lam.get_function(FunctionName=LAMBDA_FN_NAME)
        arn = resp["Configuration"]["FunctionArn"]
        print(f"Lambda exists: {arn}")
        grant_agentcore_invoke(lam, arn)
        return arn
    except lam.exceptions.ResourceNotFoundException:
        pass
    role_arn = ensure_lambda_role()
    print(f"Creating Lambda: {LAMBDA_FN_NAME}")
    # New roles can briefly fail with InvalidParameterValueException during propagation.
    arn = None
    for attempt in range(5):
        try:
            resp = lam.create_function(
                FunctionName=LAMBDA_FN_NAME,
                Runtime="python3.12",
                Role=role_arn,
                Handler="lambda_function.handler",
                Code={"ZipFile": _lambda_zip()},
                Timeout=10,
            )
            arn = resp["FunctionArn"]
            break
        except lam.exceptions.ResourceConflictException:
            # A parallel CI job (e.g. the preview/ga matrix) created it first — reuse it.
            print("  Lambda created concurrently, reusing existing function")
            arn = lam.get_function(FunctionName=LAMBDA_FN_NAME)["Configuration"]["FunctionArn"]
            break
        except lam.exceptions.ClientError as e:
            if "cannot be assumed" in str(e) or "InvalidParameterValue" in str(e):
                print(f"  role not ready, retrying ({attempt + 1})...")
                time.sleep(5)
                continue
            raise
    if not arn:
        raise RuntimeError("Lambda creation failed after retries")
    grant_agentcore_invoke(lam, arn)
    return arn


def _find_rest_apis(api):
    """All REST API ids with our name, sorted (deterministic 'winner' = first)."""
    return sorted(
        item["id"] for item in api.get_rest_apis(limit=500).get("items", []) if item.get("name") == REST_API_NAME
    )


def ensure_rest_api():
    """Create (or reuse) a minimal REST API with one GET method deployed to a stage.

    API Gateway allows duplicate names, so parallel CI jobs can each create one.
    We reap the race: keep the lowest-id API, delete the rest, so duplicates never
    accumulate and every run deterministically resolves to the same API.
    """
    api = boto3.client("apigateway", region_name=REGION)
    existing = _find_rest_apis(api)
    if existing:
        winner, dupes = existing[0], existing[1:]
        for dupe in dupes:
            print(f"Deleting duplicate REST API: {dupe}")
            try:
                api.delete_rest_api(restApiId=dupe)
            except api.exceptions.ClientError:
                pass  # best-effort; another job may be reaping it too
        print(f"REST API exists: {winner}")
        return winner, REST_API_STAGE
    print(f"Creating REST API: {REST_API_NAME}")
    rest_api_id = api.create_rest_api(name=REST_API_NAME, description="e2e gateway-target prereq")["id"]
    root_id = next(r["id"] for r in api.get_resources(restApiId=rest_api_id)["items"] if r["path"] == "/")
    res_id = api.create_resource(restApiId=rest_api_id, parentId=root_id, pathPart="hello")["id"]
    # operationName → operationId in the OpenAPI export. AgentCore's api-gateway
    # target rejects operations that have no operationId.
    api.put_method(
        restApiId=rest_api_id,
        resourceId=res_id,
        httpMethod="GET",
        authorizationType="NONE",
        operationName="getHello",
    )
    api.put_integration(
        restApiId=rest_api_id,
        resourceId=res_id,
        httpMethod="GET",
        type="MOCK",
        requestTemplates={"application/json": '{"statusCode": 200}'},
    )
    api.put_method_response(
        restApiId=rest_api_id, resourceId=res_id, httpMethod="GET", statusCode="200",
    )
    api.put_integration_response(
        restApiId=rest_api_id, resourceId=res_id, httpMethod="GET", statusCode="200",
        responseTemplates={"application/json": '{"message": "hello"}'},
    )
    api.create_deployment(restApiId=rest_api_id, stageName=REST_API_STAGE)
    print(f"REST API created: {rest_api_id} (stage {REST_API_STAGE})")

    # Two jobs may have both reached the create path concurrently. Reconcile to the
    # lowest id so every job converges on the same API and no duplicates survive.
    all_ids = _find_rest_apis(api)
    winner = all_ids[0] if all_ids else rest_api_id
    for dupe in (i for i in all_ids if i != winner):
        print(f"Deleting duplicate REST API created by a parallel job: {dupe}")
        try:
            api.delete_rest_api(restApiId=dupe)
        except api.exceptions.ClientError:
            pass
    return winner, REST_API_STAGE


def _try(label, fn):
    """Run a resource creator; on AccessDenied return None so the test can skip
    the dependent target instead of failing the whole suite. Restricted CI roles
    (e.g. e2e-github-actions) may lack lambda:*/apigateway:* permissions."""
    try:
        return fn()
    except botocore.exceptions.ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("AccessDeniedException", "AccessDenied", "UnauthorizedOperation"):
            print(f"⚠️  Skipping {label}: not authorized ({e.response['Error']['Code']})")
            return None
        raise


def main():
    lambda_arn = _try("lambda", ensure_lambda)
    api = _try("api-gateway", ensure_rest_api)
    rest_api_id, stage = api if api else (None, None)

    out = {
        "lambdaArn": lambda_arn,
        "restApiId": rest_api_id,
        "restApiStage": stage,
    }
    with open(OUT_FILE, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote prereqs to {OUT_FILE}:")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
