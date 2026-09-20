# AgentCore with AWSCC Terraform resources

This standalone Terraform root deploys one Python AgentCore Runtime, one
short-term Memory, a runtime IAM role, and a versioned encrypted S3 artifact
bucket with public access blocked. It requires no AgentCore CLI or CDK.

`awscc_bedrockagentcore_runtime` and `awscc_bedrockagentcore_memory` use the AWSCC provider and Cloud Control APIs. AWSCC uses CloudFormation resource schemas and handlers, but creates individual AgentCore resources without a CloudFormation stack. Supporting IAM and S3 use the AWS provider.

## Deploy

Use Terraform 1.10 or later, Python 3, and AWS credentials for a region that
supports AgentCore. The providers are pinned in `versions.tf`.

```sh
cp terraform.tfvars.example terraform.tfvars
# Edit expected_account_id, name_prefix, and region.
export AWS_PROFILE=your-profile
python3 build.py
terraform init
terraform fmt -check
terraform validate
terraform plan -out=deploy.tfplan
terraform apply deploy.tfplan
terraform output
```

The default AWS credential chain also supports workload credentials without a
profile. Both providers in the AWSCC example must use the same credentials.
The AWS provider checks `expected_account_id` before creating supporting
infrastructure; the runtime depends on that infrastructure. The AWSCC Memory
also depends on an account-identity precondition.

## Invoke

```sh
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$(terraform output -raw runtime_arn)" \
  --runtime-session-id "$(python3 -c 'import uuid; print(uuid.uuid4())')" \
  --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"message":"hello"}' response.json
cat response.json
```

Use the deployment's region in the command. The dependency-free sample exposes
`/ping` and `/invocations` on port 8080. It echoes the request and its configured
Memory ID; it does not call a model or write events to Memory. Invocation uses
the caller's IAM permissions. `PUBLIC` is the runtime's network configuration,
not anonymous invocation access.

## Customize

- `main.tf` contains the AgentCore resources. Add more resources alongside them.
- `variables.tf` defines the inputs, including descriptions, tags, environment
  variables, and Memory retention (3-365 days for this provider).
- Replace `agent.py` and rerun `build.py` for a dependency-free Python app.
  For dependencies, supply `runtime_zip_path` pointing to a Python 3.12,
  Linux ARM64 ZIP containing the application and dependencies at its root.
  Set `runtime_entry_point` if the startup command differs.
- The runtime role has artifact-read, logging, and short-term event permissions
  for this Memory. Add application-specific permissions, such as model invocation,
  in `iam.tf`.
- `outputs.tf` exposes Runtime and Memory IDs/ARNs for other tools or modules.
- State defaults to local. A team can add a Terraform backend block before
  initialization. Treat changing an existing deployment's provider as an explicit
  import/migration task; these two examples use separate state.

Change `description`, plan and apply again to update in place. A following
`terraform plan -detailed-exitcode` should return 0 when nothing changed.
The bucket keeps object versions and has `force_destroy = false`.

These templates cover Runtime and short-term Memory. Gateway, Harness,
long-term Memory strategies, containers, and VPC deployments need additional
resource configuration.
