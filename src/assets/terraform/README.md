# Terraform project

This preview uses typed `hashicorp/awscc` resources for AgentCore. AWSCC calls
Cloud Control APIs backed by CloudFormation resource schemas and handlers. It
creates ordinary AgentCore resources, without a CloudFormation stack. IAM and S3
use `hashicorp/aws`.
`agentcore project deploy` creates a separate Terraform root for each named target.
It writes only `agentcore.generated.tf.json` and the target's `deployment.json`
binding. Add your own `.tf` files in that target directory to include extra
resources in the same plan and state.

Commit `deployment.json`, custom configuration, and `.terraform.lock.hcl`. Keep
state files, plans, provider caches, and generated configuration private. They can
contain environment variable values. The generated configuration references
immutable local ZIPs under `agentcore/.cli/terraform/artifacts`.

The default state backend is local. Back up state, and do not deploy the same
target from another checkout with an empty local state. For team use, configure
an encrypted remote state backend with locking in the target directory and
migrate the existing state with Terraform before deploying from another checkout.
The CLI does not automatically migrate state, change workspaces, or reconfigure
a backend.

Build and deploy through `agentcore project build` and `agentcore project deploy`.
You can also inspect or operate the generated root with ordinary Terraform after
building it. Use credentials for the account and region in `aws-targets.json`.
Provider credentials and backend configuration should use that same identity.

Supported: Python CodeZip runtimes, short-term memories, PUBLIC/VPC network
configuration, IAM invocation, tags, environment variables, lifecycle timeouts,
and provided execution roles. Generated roles can invoke Bedrock models, write
runtime logs, read their own ZIPs, and use the project's short-term memories.
Provided execution roles must already have these permissions.

Unsupported configuration fails before Terraform runs. Harnesses, container and
TypeScript builds, memory strategies, credentials, gateways, policies, datasets,
and other AgentCore families are follow-up work. Start with
`--backend terraform --template agent-python-minimal`, `agent-python-langchain`,
or `empty`. Add short-term memory through the normal project commands.

The artifact bucket has versioning and `prevent_destroy`. Removing agent
resources retains that bucket and its historical ZIP versions. Removing the
bucket eventually requires an explicit Terraform configuration change.

Status and resource resolution read the last successful Terraform output, not
a live refresh of every service resource. Use `terraform plan` to detect drift.
An incomplete first apply may leave resources in state before outputs exist;
rerun deploy to converge. The CLI preserves state and saved plans on failure.
