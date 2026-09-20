# Choosing CDK or Terraform

This is a preview of a second deployment engine for new AgentCore projects.
Existing projects continue to use CDK. Select the engine when creating a project:

```sh
agentcore project create --name MyAgent --backend cdk
agentcore project create --name MyAgent --backend terraform --template agent-python-minimal
```

The interactive create wizard offers the same choice. Terraform currently supports
`agent-python-minimal`, `agent-python-langchain`, and `empty`. Other templates fail
before scaffolding. The default managed-Harness template is not supported by this
preview; choose a supported template explicitly.

The selection is saved as `managedBy: "CDK"` or `managedBy: "TERRAFORM"` in
`agentcore/agentcore.json`. Build, deploy, status, and runtime invocation retain the
existing command tree:

```sh
cd MyAgent
agentcore project build
agentcore project deploy
agentcore project status
```

There is no per-deploy engine override. A target bound to one engine cannot be
transferred by editing `managedBy`. Existing deployments require an explicit
ownership/state migration, which this preview does not automate.

## Resource engine

AgentCore resources use `hashicorp/aws` 6.65.0:

```hcl
resource "aws_bedrockagentcore_memory" "history" {
  name                  = "MyAgent_default_history"
  event_expiry_duration = 7
}
```

Runtime maps to `aws_bedrockagentcore_agent_runtime`. These resources use the
AgentCore service APIs directly. IAM and S3 also use the native AWS provider.
There is no CloudFormation stack or AWSCC provider in this path.

This provides idiomatic Terraform refresh and resource-level plans. Coverage is
limited by each native provider implementation: this pinned Memory version
requires at least seven retention days, although the service/CloudFormation
schema permits three. New fields need a provider release and a qualified mapping.

## Project and extension contract

The current `ProjectBackend` interface handles build, deploy, deployed-resource
resolution, and project status. `TerraformBackend` implements it without loading
CDK. `TerraformCompiler` converts the project into Terraform JSON;
`TerraformProvider` contains the engine-specific resource names and shapes.

Each target gets a root at `agentcore/terraform/<target>/`. The compiler owns
`agentcore.generated.tf.json`; customers can add `.tf` files alongside it, and
those files participate in the same plan and state. The target's committed
`deployment.json` binds project, account, region, and provider implementation.
Generated configuration, state, plans, variable files, and provider caches are
ignored by git. Commit the provider lockfile.

Terraform installs pinned providers, validates the root, and writes a saved plan.
The CLI applies that exact plan. Deletes and replacements use the existing
teardown confirmation callback. A declined plan or partial apply keeps its
configuration, saved plan, and state so the customer can inspect and resume it.
A local lock covers generation through apply; Terraform also locks its state.

Both providers and the state backend receive the credentials whose account was
checked with STS. Credentials are not written into Terraform configuration or
passed as command arguments. If a session expires during a long operation,
refresh credentials and rerun deploy; Terraform can converge from its state.

State is local by default. Before collaborating from multiple checkouts, configure
an encrypted remote backend with locking in the target root and migrate state
using Terraform. This preview does not automate remote-state provisioning or
migration. A previously applied binding with missing outputs refuses deployment,
so an empty local checkout cannot silently recreate that target.

## Current supported subset

- Python CodeZip runtimes with a `.py` entrypoint; dependency-free projects or
  locked `uv` projects. Dependencies are built for Linux ARM64. Source timestamps
  do not change the ZIP hash; `.env*`, virtual environments, caches, and symlinks
  are excluded or rejected.
- Short-term Memory, retention, tags, encryption key and existing execution role.
- Runtime descriptions, PUBLIC/VPC network configuration, AWS_IAM authorization,
  environment variables, lifecycle timeouts, tags, and existing execution roles.
- Versioned, encrypted S3 code storage, blocked public access, execution roles,
  and scoped artifact/log/memory policies. Generated roles can invoke Bedrock
  foundation models and inference profiles. Existing roles remain customer-owned
  and must already carry the necessary permissions.
- Project Memory IDs are injected using the existing `AGENTCORE_MEMORY_<NAME>_ID`
  convention. Status and invocation resolve the Terraform output contract.

Unsupported project resource families and advanced fields fail before Terraform
runs. Memory strategies, Harnesses, container/TypeScript packaging, credentials,
gateway/policy/dataset resources, endpoints, custom authorizers, filesystem mounts,
connections, and automatic instrumentation remain follow-up work. Schema presence
in a provider alone is not an implementation of these project semantics.

The artifact bucket is retained with `prevent_destroy`, including when the last
runtime is removed. Explicitly removing it requires a separate configuration
change. Status reports the last successful Terraform output; it is not a live
service refresh. Use `terraform plan` for drift detection. A failed first apply
can create resources before outputs exist; rerun deploy to converge.

## Extending the preview

Add each resource's semantic validation, provider mapping, dependencies, IAM,
and output handling together. Extend the resource output schema and the existing
CLI resource union when introducing a new family. Keep Terraform addresses stable
across project reordering. Add update, drift, import, and replacement coverage
before calling a mapping supported. A provider change for an existing resource
requires explicit state migration, not an automatic fallback.

Longer term, extract neutral project loading, naming, artifact types and bindings
into a package shared with the L3 library. The existing L3 transformer returns CDK
props; importing it into Terraform would preserve a CDK dependency. This preview
keeps that boundary explicit and does not change the L3 package.
