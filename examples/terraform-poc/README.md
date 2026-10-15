# Terraform backend PoC

This example exercises an experimental Terraform deployment backend for a small AgentCore project:

- A Python CodeZip runtime and memory with a semantic strategy.
- An IAM-authenticated MCP gateway backed by a Python Lambda tool.
- A policy engine associated with the gateway.
- Online evaluations using `Builtin.Helpfulness`.

The backend generates Terraform JSON configuration from `agentcore/agentcore.json`. AgentCore resources use AWSCC 1.106.0, except for gateway targets: that release does not expose a gateway target resource, so the example uses AWS provider 6.69.0 for its Lambda target. The AWS provider also manages IAM, S3, Lambda, and logs. Resource creation is owned by Terraform.

The example has been packaged reproducibly, validated against both pinned providers, and planned with Terraform 1.16.6 (25 resources). Live deployment, invocation, policy enforcement, evaluation results, updates, and teardown remain unverified. The steps below describe the experiment to run.

## Prerequisites

- Build this branch of the CLI with `bun install --frozen-lockfile` and `bun run build`.
- Install Terraform 1.16.6 and `uv`, and make both available on `PATH`.
- Configure AWS credentials for a disposable development account and an AgentCore-supported region.
- Ensure the account can invoke the Bedrock model used by the example, `us.amazon.nova-lite-v1:0`. To select another model, add a `MODEL_ID` entry to the runtime's `envVars`.

This example creates billable resources and enables online evaluation at 100% sampling. Use it for a bounded experiment and tear it down afterward. The sample `permit(principal, action, resource);` policy permits all gateway actions to authenticated callers; replace it with your intended policy before using the configuration outside this example.

## Deploy the example

Copy this directory outside the repository before using it so configuration changes and deployment state remain separate from the checked-in fixture. Set `CLI` to the absolute path of this branch's `dist/index.js`.

```sh
export CLI=/absolute/path/to/agentcore-cli/dist/index.js
export AWS_PROFILE=your-development-profile
export AWS_REGION=us-west-2
cd /path/to/your/copied/terraform-poc

node "$CLI" build
node "$CLI" deploy --region "$AWS_REGION" --json
node "$CLI" status --region "$AWS_REGION" --json
```

The default deployment target is recorded in `agentcore/aws-targets.json`. Terraform configuration, asset archives, dependency locks, and local state live beneath `agentcore/terraform/`. Keep that directory private and preserve it until teardown completes: Terraform state can contain configuration values and is needed to manage the resources. This PoC uses local state for one operator; shared remote state and CDK-to-Terraform migration are outside its scope.

Deploy also follows the existing CLI setting for enabling CloudWatch Transaction Search. That setup is an account-level telemetry prerequisite, runs outside Terraform, and is not reverted when this example is destroyed. A setup warning must be resolved before treating online evaluation as verified.

To start a new project instead:

```sh
node "$CLI" create --name MyTerraformProject --template empty --managed-by Terraform
```

Use the existing `agentcore add` commands to populate the project. The backend validates its supported subset before deployment and reports unsupported resource types or settings. A Terraform project is not a promise of coverage for every `agentcore.json` option.

## Exercise the deployed resources

```sh
node "$CLI" invoke --runtime Agent --payload '{"operation":"ping"}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"memory","message":"I prefer green tea."}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"tools"}'
node "$CLI" invoke --runtime Agent --payload '{"operation":"echo","message":"Hello from Terraform."}'
node "$CLI" invoke --runtime Agent --payload '{"prompt":"How can I keep a cup of tea warm?"}'
```

The memory operation writes an event and lists session events. Semantic extraction is asynchronous. The gateway operations use the runtime's IAM credentials to discover and invoke the Lambda tool. The final operation invokes a Strands agent and produces model telemetry for online evaluation; an active evaluation configuration alone does not establish that evaluation results are being produced.

To examine enforcement, change the sample policy to `forbid(principal, action, resource);`, redeploy, and check that calling the tool is denied. Set the policy's `enforcementMode` to `LOG_ONLY`, redeploy, and check its observed behavior before restoring the original policy. The gateway's policy-engine mode remains `ENFORCE`; it is a separate setting.

The compiler also maps the statement through AWSCC's `definition.policy.statement` input. A valid Dogwood statement can be supplied there, but schema support and a successful deployment of a particular Dogwood policy are separate checks.

## Updates and teardown

Change a runtime source file or a supported configuration value and run `deploy` again. Repeating a deployment with unchanged inputs should produce a no-change plan. Stable Terraform addresses are based on resource names; renaming a resource can replace it.

Removing a project resource and deploying reconciles its Terraform resources. To tear down the entire example:

```sh
node "$CLI" remove all --yes
node "$CLI" deploy --yes --region "$AWS_REGION" --json
```

Keep the generated directory after a failed apply or teardown so the operation can be retried. Do not edit `managedBy` on an existing CDK deployment to attempt a migration.
