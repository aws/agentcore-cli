# Terraform backend PoC

This example exercises an experimental Terraform deployment backend for a small AgentCore project:

- A Python CodeZip runtime and memory with a semantic strategy.
- An IAM-authenticated MCP gateway backed by a Python Lambda tool.
- A policy engine associated with the gateway.
- Online evaluations using `Builtin.Helpfulness`.

The backend scaffolds HCL root files and references the reusable `agentcore-application` module maintained in the AgentCore L3 constructs repository. The root reads `agentcore/agentcore.json` and passes a typed `spec` object into the module. Terraform reads the JSON on every plan, so changing a supported setting does not require CLI regeneration.

AgentCore resources use AWSCC 1.106.0, except for gateway targets: that release does not expose a gateway target resource, so the example uses AWS provider 6.69.0 for its Lambda target. The AWS provider also manages IAM, S3, and Lambda. As with the CDK constructs, the services create their own log groups.

This example has been deployed live with Terraform 1.16.6, both from an empty account state and incrementally. Every step below was exercised: invocation, memory events and semantic extraction, gateway tool discovery and calls, policy permit/forbid/`LOG_ONLY` behavior, online evaluation scores, code updates, a no-change repeat plan, and teardown. These were manual runs in one test account, not automated end-to-end tests.

## Prerequisites

- Build this branch of the CLI with `bun install --frozen-lockfile` and `bun run build`.
- Install Terraform 1.16.6 and `uv`, and make both available on `PATH`.
- Configure AWS credentials for a disposable development account and an AgentCore-supported region.
- Ensure the account can invoke the Bedrock model used by the example, `us.amazon.nova-lite-v1:0`. To select another model, add a `MODEL_ID` entry to the runtime's `envVars`.

Set `CLI` to the absolute path of this branch's `dist/index.js`:

```sh
export CLI=/absolute/path/to/agentcore-cli/dist/index.js
```

This example creates billable resources and enables online evaluation at 100% sampling. Use it for a bounded experiment and tear it down afterward. The sample `permit(principal, action, resource is AgentCore::Gateway);` policy permits all gateway actions to authenticated callers; replace it with your intended policy before using the configuration outside this example.

## Create a project

```sh
node "$CLI" create --name MyTerraformProject --template empty --iac terraform
```

`--iac` accepts `cdk` or `terraform`, case-insensitively, and defaults to CDK. Terraform projects immediately contain:

```text
agentcore/
  agentcore.json
  terraform/
    main.tf
    providers.tf
    variables.tf
    outputs.tf
    artifacts.json
```

Creation does not require Terraform or AWS credentials. Use the existing `agentcore add` commands to populate the project, or edit its JSON directly. The backend validates its supported subset before deployment and reports unsupported resource types or settings.

The customer owns the root `.tf` files. Build and deploy preserve those edits. The module source is pinned to an immutable commit in the L3 constructs repository; `terraform init` downloads it. During this draft PoC the pin points to the companion PR branch in the contributor fork. Updating the module version is an explicit root HCL change.

## Deploy the connected example

Copy this directory outside the repository before using it so configuration changes and deployment state remain separate from the checked-in fixture. Policy names are unique per account and Region, so a second copy in the same account needs a different project name and policy name. Set `CLI` to the absolute path of this branch's `dist/index.js`.

```sh
export CLI=/absolute/path/to/agentcore-cli/dist/index.js
export AWS_PROFILE=your-development-profile
export AWS_REGION=us-west-2
cd /path/to/your/copied/terraform-poc

node "$CLI" build
node "$CLI" deploy --region "$AWS_REGION" --json
node "$CLI" status --region "$AWS_REGION" --json
```

Build packages the runtime and Lambda and prepares `agentcore/terraform/`. Every deployment target uses the same editable root HCL and shared artifact manifest. Deploy writes generated inputs, state, plans, and Terraform initialization data under `agentcore/terraform/.targets/<target>/`. The default deployment target is recorded in `agentcore/aws-targets.json`.

Root HCL and the provider lock file can be version-controlled. Generated ZIPs, artifact manifests, deployment variables, plans, and local state are ignored. Preserve state until teardown completes: it can contain sensitive configuration values and is needed to manage resources. This CLI PoC supports local state for one operator; remote backends, custom state paths, and CDK-to-Terraform migration are outside its scope.

Named targets share the root `.tf` files, so edits apply to whichever target is planned next. Each target has a separate `.targets/<target>/` directory for deployment inputs and state. State is bound to its account, region, and target; changing those values requires a separate target or an explicit migration. Terraform workspaces remain set to `default`; target isolation comes from the backend state path and `TF_DATA_DIR`.

Deploy also follows the existing CLI setting for enabling CloudWatch Transaction Search. That setup is an account-level telemetry prerequisite, runs outside Terraform, and is not reverted when this example is destroyed. A setup warning must be resolved before treating online evaluation as verified.

## Change configuration with Terraform directly

After building code artifacts, the shared root works without the CLI. Select a target and configure its local backend explicitly:

```sh
cd agentcore/terraform
export TF_WORKSPACE=default
export TF_DATA_DIR="$PWD/.targets/default/.terraform"
mkdir -p .targets/default
terraform init -reconfigure -backend-config="path=$PWD/.targets/default/terraform.tfstate"
terraform plan -var="account_id=123456789012" -var="region=us-west-2" -var="target_name=default"
```

Replace the example account ID with your AWS account. For a named target, replace `default` in both paths and `target_name` with that target's name. Keep each target's account, region, state path, and initialization directory together. The root's backend defaults to `.targets/default/terraform.tfstate` for a direct default-target initialization.

After CLI deploy has generated the target's inputs, use its explicit variables file instead:

```sh
terraform plan -var-file=.targets/default/deployment.tfvars.json
```

Edit a supported value such as memory retention in `agentcore.json`, then run the same `terraform plan` command again. The module receives the updated object immediately. After reviewing the plan, apply it with the same target inputs. Changes to application source still require rebuilding the ZIPs and updating their artifact hashes.

The checked-in [`agentcore/terraform/`](agentcore/terraform/) directory is the shared root example. It references the same pinned module from the L3 constructs repository. `agentcore build` writes the artifact manifest; callers supplying their own ZIPs can use the manifest contract described in the [module README](https://github.com/jariy17/agentcore-l3-cdk-constructs/blob/e9c53da25f7cde41b72ec0101dea482d507bd479/terraform/modules/agentcore-application/README.md).

The root can pass inline HCL instead of JSON. This allows values from customer resources to enter the `spec` directly, for example `envVars = [{ name = "ORDERS_TABLE", value = aws_dynamodb_table.orders.name }]`. Outputs such as `module.application.runtimes["Agent"].role_name` allow a separate IAM policy to grant that runtime access to the table. Terraform follows these references to order changes.

References between the project's resources are resolved inside the module: policy engine to gateway, Lambda and gateway to target, memories/gateways to runtime, and runtime logs to online evaluation. Circular references are rejected by Terraform. See the [module's inputs and outputs](https://github.com/jariy17/agentcore-l3-cdk-constructs/blob/e9c53da25f7cde41b72ec0101dea482d507bd479/terraform/modules/agentcore-application/README.md) for the contract and limits.

## Exercise the deployed resources

```sh
node "$CLI" invoke --runtime Agent --payload '{"operation":"ping"}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"memory","message":"I prefer green tea."}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"tools"}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"echo","message":"Hello from Terraform."}'
node "$CLI" invoke --runtime Agent --payload '{"prompt":"How can I keep a cup of tea warm?"}'
```

The memory operation writes an event and lists session events. Semantic extraction is asynchronous. The gateway operations use the runtime's IAM credentials to discover and invoke the Lambda tool. The final operation invokes a Strands agent and produces model telemetry for online evaluation; results appear in `/aws/bedrock-agentcore/evaluations/results/<config id>` a few minutes after the session goes idle. Sessions without model spans, such as the probe operations, are recorded as evaluation errors.

To examine enforcement, change the sample policy to `forbid(principal, action, resource is AgentCore::Gateway);`, redeploy, and check that calling the tool is denied. Set the policy's `enforcementMode` to `LOG_ONLY`, redeploy, and check its observed behavior before restoring the original policy: with the only policy in `LOG_ONLY`, no enforced policy permits the call, so the gateway still denies it by default. The gateway's policy-engine mode remains `ENFORCE`; it is a separate setting.

The module maps the statement through AWSCC's `definition.policy.statement` input. A valid Dogwood statement can be supplied there, but schema support and a successful deployment of a particular Dogwood policy are separate checks.

## Updates and teardown

Change a runtime source file or a supported configuration value and run `deploy` again. Repeating a deployment with unchanged inputs should produce a no-change plan. Stable Terraform addresses are based on resource names; renaming a resource can replace it.

Removing a project resource and deploying reconciles its Terraform resources. To tear down the entire example:

```sh
node "$CLI" remove all --yes
node "$CLI" deploy --yes --region "$AWS_REGION" --json
```

Keep the generated directory after a failed apply or teardown so the operation can be retried. Do not edit `managedBy` on an existing CDK deployment to attempt a migration.

Earlier Terraform PoCs used flat resources or separate editable roots under `terraform/<target>/`. This implementation refuses those layouts instead of moving state or customer edits automatically. Existing deployments require an explicit migration before using the shared root.

## Known limitations

- A project that declares a Cedar policy deploys to one target per account. Policy names are account-unique in the service, and both this module and the CDK L3 construct send the policy name from `agentcore.json` without the project and target prefix that every other resource gets. A second target reports `CreatePolicy ... Policy with the same name already exists` after creating everything else, leaving that target partially deployed. Give each target its own project name, or drop `policyEngines[].policies` from the second target's project.
- Teardown leaves the CloudWatch log groups the service and Lambda create for a runtime and a gateway target. Terraform never owned them, so removing the resources keeps their logs; delete the groups yourself when the logs are no longer wanted.
- `backend "local"` in the generated `providers.tf` points at `.targets/default/terraform.tfstate`. The CLI overrides that per target, so running `terraform` directly in the root reads and writes the **default** target's state whatever target you deployed last. Pass `-backend-config=path=...` and `TF_DATA_DIR` for another target, or run the commands through `agentcore deploy --target`.
