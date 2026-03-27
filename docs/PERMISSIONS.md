# IAM Permissions

This guide covers how to configure AWS IAM for the AgentCore CLI. The first half is written for platform administrators
who provision roles and policies in environments where access is tightly controlled. The second half is a complete
action-by-action reference. Developers who just need to get unblocked can skip to
[What developers need](#what-developers-need).

Ready-to-use policy documents are provided at [iam-policy-user.json](./policies/iam-policy-user.json),
[iam-policy-cfn-execution.json](./policies/iam-policy-cfn-execution.json), and
[iam-policy-boundary.json](./policies/iam-policy-boundary.json). Replace `ACCOUNT_ID` placeholders with your AWS account
number before deploying.

## How the CLI uses AWS

The CLI interacts with your AWS account in two fundamentally different ways, and understanding the distinction is the
key to setting up permissions correctly.

**Direct API calls.** The CLI itself makes SDK calls for things like invoking agents, tailing logs, checking deployment
status, and managing credential providers. These calls use the developer's own IAM credentials, so those credentials
need the corresponding permissions.

**CDK deployments.** When a developer runs `agentcore deploy`, the CLI uses AWS CDK to synthesize a CloudFormation
template and hand it off to the CloudFormation service. CloudFormation then assumes a separate IAM role (the "CFN
execution role") to actually create and manage the infrastructure: runtimes, gateways, ECR repositories, IAM roles for
the agents themselves, and so on. The developer's credentials are not used for this part. They only need permission to
assume the CDK bootstrap roles that kick off the deployment.

This separation is what makes least-privilege feasible. Developers get a narrow policy for the SDK calls they make
directly, while the broad infrastructure permissions live on a role that only CloudFormation can assume.

## Setting up permissions

### 1. Developer policy (direct SDK calls + CDK role assumption)

Attach this to every IAM user or role that will run AgentCore CLI commands. The provided
[iam-policy-user.json](./policies/iam-policy-user.json) covers everything. At a high level, it grants:

- `sts:AssumeRole` on the four CDK bootstrap roles (deploy, file-publishing, image-publishing, lookup)
- `sts:GetCallerIdentity`, `cloudformation:DescribeStacks`, `tag:GetResources` for basic operations
- `bedrock-agentcore:Invoke*`, `bedrock-agentcore:Get*`, `bedrock-agentcore:List*` for invoking agents and checking
  status
- Credential provider and token vault actions for `deploy` when the project uses identity features
- CloudWatch Logs, X-Ray, and Application Signals actions for `logs`, `traces`, and observability setup
- Bedrock actions for agent import and AI-assisted code generation (optional, see
  [Scoping down by feature](#scoping-down-by-feature))

To create this policy:

```bash
aws iam create-policy \
  --policy-name AgentCoreCLIUser \
  --policy-document file://docs/policies/iam-policy-user.json
```

Then attach it to your developer role or group:

```bash
aws iam attach-role-policy \
  --role-name MyDeveloperRole \
  --policy-arn arn:aws:iam::ACCOUNT:policy/AgentCoreCLIUser
```

### 2. CloudFormation execution role (infrastructure provisioning)

This is the role that CloudFormation assumes during `agentcore deploy` to create and update the actual infrastructure.
It is part of the CDK bootstrap stack (`CDKToolkit`) and is named `cdk-*-cfn-exec-role-*`.

If your account uses the default CDK bootstrap, this role already has `AdministratorAccess` and you do not need to do
anything.

If your organization scopes down the execution role (common in enterprise environments), you need to ensure it has
permissions for every resource type AgentCore deploys. The provided
[iam-policy-cfn-execution.json](./policies/iam-policy-cfn-execution.json) is a ready-to-use policy for this. It covers:

- All `bedrock-agentcore:*` actions for runtime, memory, gateway, evaluator, and policy engine resources
- IAM role and policy management (CloudFormation creates execution roles for each deployed resource)
- S3 for CDK asset staging
- KMS for encryption keys
- ECR and CodeBuild for container-based builds
- Lambda for MCP Lambda compute and CDK custom resources
- CloudWatch Logs for log group management
- CloudFormation stack operations
- SSM Parameter Store for CDK bootstrap version lookups
- Secrets Manager for credential provider secret storage

To create the scoped-down execution policy:

```bash
aws iam create-policy \
  --policy-name AgentCoreCFNExecution \
  --policy-document file://docs/policies/iam-policy-cfn-execution.json
```

Then pass it to CDK bootstrap (see next section).

## Bootstrapping CDK

CDK needs to be bootstrapped once per account/region combination before the first `agentcore deploy`. The CLI normally
handles this automatically, but in locked-down environments an administrator may need to run it manually.

Bootstrap creates a `CDKToolkit` CloudFormation stack containing several IAM roles:

| Bootstrap Role                  | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `cdk-*-deploy-role-*`           | Assumed by the CLI user to trigger deployments                 |
| `cdk-*-cfn-exec-role-*`         | Assumed by CloudFormation to create/update/delete resources    |
| `cdk-*-file-publishing-role-*`  | Assumed by the CLI to upload code assets to S3                 |
| `cdk-*-image-publishing-role-*` | Assumed by the CLI to push container images to ECR             |
| `cdk-*-lookup-role-*`           | Assumed by the CLI to look up VPCs, AZs, etc. during synthesis |

CloudFormation assumes the CFN execution role to provision infrastructure, not your user's credentials. This means your
IAM principal only needs `sts:AssumeRole` on the bootstrap roles, plus permissions for the direct SDK calls. The broad
infrastructure permissions (creating IAM roles, ECR repos, Lambda functions, etc.) live on the CFN execution role
instead.

### Default bootstrap (quick start)

By default, CDK bootstrap grants `AdministratorAccess` to the CFN execution role. In this configuration CloudFormation
can create any resource, and you only need the [user permissions](#user-permissions) listed below.

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

### Scoped-down bootstrap (enterprise)

Organizations often restrict the CFN execution role to a least-privilege policy. If your account does this, the
execution role must include permissions for every resource type that AgentCore deploys. See
[CFN execution role permissions](#cfn-execution-role-permissions) for the full list.

To restrict the CFN execution role to only the permissions AgentCore requires, pass a custom policy during bootstrap:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION \
  --cloudformation-execution-policies arn:aws:iam::ACCOUNT_ID:policy/AgentCoreCFNExecution
```

If you need to update the execution policy later (for example, when a new AgentCore release introduces new resource
types), update the policy and re-run the bootstrap command. CDK bootstrap is idempotent. For full details, see the
[AWS CDK Bootstrap documentation](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html).

### Trust policy for the CDK bootstrap roles

The CDK bootstrap roles need to be assumable by your developers. By default, bootstrap configures them to trust the
entire account. If your organization restricts trust policies, ensure the four bootstrap roles (`cdk-*-deploy-role-*`,
`cdk-*-file-publishing-role-*`, `cdk-*-image-publishing-role-*`, `cdk-*-lookup-role-*`) have a trust policy that allows
your developer roles to assume them:

```json
{
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::ACCOUNT_ID:role/MyDeveloperRole"
  },
  "Action": "sts:AssumeRole"
}
```

## Scoping down by feature

The policy files provided cover every AgentCore feature. If your team only uses a subset, you can remove the
corresponding statements to further tighten the policies. This table maps features to the policy statements that can be
safely removed:

| If your team does not use...    | Remove from user policy                                              | Remove from CFN execution policy                                                                       |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Container builds (CodeZip only) | _(no change)_                                                        | `EcrContainerBuilds`, `CodeBuildContainerBuilds`                                                       |
| MCP Lambda compute              | _(no change)_                                                        | `LambdaMcpAndCustomResources` (keep if using container builds, which need Lambda for custom resources) |
| Agent import from Bedrock       | `BedrockAgentImport`                                                 | _(no change)_                                                                                          |
| AI-assisted code generation     | `BedrockModelInvocation`                                             | _(no change)_                                                                                          |
| Identity/credential providers   | `IdentityCredentialManagement`, `TokenVaultKmsKeyCreation`           | `SecretsManagerForCredentials`                                                                         |
| Policy engine                   | `PolicyGeneration`                                                   | Remove `*PolicyEngine*` and `*Policy` actions from `BedrockAgentCoreResources`                         |
| Online evaluations              | Remove `UpdateOnlineEvaluationConfig` from `AgentCoreResourceStatus` | Remove `*OnlineEvaluationConfig*` actions from `BedrockAgentCoreResources`                             |

## Hardening with permission boundaries

The CFN execution role policy includes `iam:CreateRole` with `Resource: "*"`. Without further constraints,
CloudFormation could theoretically create a role with `AdministratorAccess` and a trust policy allowing the developer to
assume it. This is a well-known CDK privilege escalation pattern.

[IAM permission boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) close this
gap. A permission boundary caps the effective permissions of any role it is attached to, regardless of what identity
policies that role carries. Even if someone attaches `AdministratorAccess` to an execution role, the boundary limits
what the role can actually do.

The setup has three parts: creating the boundary policy, adding deny statements to the CFN execution role so it is
forced to apply the boundary, and scoping the user policy to a single account.

### Step 1: Create the execution role boundary

This policy defines the maximum permissions any AgentCore execution role (runtime, memory, gateway, etc.) can have at
runtime. Create it once per account.

The provided [iam-policy-boundary.json](./policies/iam-policy-boundary.json) allows:

- `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` for model access
- CloudWatch Logs scoped to `/aws/bedrock-agentcore/*` log groups
- X-Ray trace submission
- CloudWatch metrics scoped to the `bedrock-agentcore` namespace
- `bedrock-agentcore:GetWorkloadAccessToken*` for identity federation

```bash
aws iam create-policy \
  --policy-name AgentCoreExecutionRoleBoundary \
  --policy-document file://docs/policies/iam-policy-boundary.json
```

### Step 2: Add deny statements to the CFN execution role

The provided [iam-policy-cfn-execution.json](./policies/iam-policy-cfn-execution.json) includes three deny statements
that close the escalation paths. Replace `ACCOUNT_ID` with your account number before deploying.

| Statement                        | What it blocks                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ForceExecutionRoleBoundary`     | Denies `iam:CreateRole` unless the boundary is attached. Any role CloudFormation creates must carry `AgentCoreExecutionRoleBoundary`.            |
| `PreventBoundaryRemoval`         | Denies `iam:DeleteRolePermissionsBoundary` and `iam:PutRolePermissionsBoundary`. Prevents removing or swapping the boundary after role creation. |
| `PreventBoundaryPolicyTampering` | Denies `iam:CreatePolicyVersion`, `iam:DeletePolicy`, etc. on the boundary policy itself. Prevents widening the boundary to bypass it.           |

Together these ensure that even though `iam:CreateRole` targets `Resource: "*"`, every created role is capped by the
boundary, and neither the boundary nor its attachment can be tampered with.

> **Note:** These deny statements require a corresponding update to the AgentCore CDK constructs. The constructs do not
> currently attach a `permissionsBoundary` to the IAM roles they create (runtime, memory, gateway, etc.), so
> CloudFormation will fail to create those roles when `ForceExecutionRoleBoundary` is active. Until the CDK constructs
> are updated to accept and apply a permission boundary ARN, treat this section as a recommended future configuration.
> You can still create the boundary policy (Step 1) and scope the user policy (Step 3) today.

### Step 3: Scope the user policy to your account

The provided [iam-policy-user.json](./policies/iam-policy-user.json) uses `ACCOUNT_ID` placeholders in the CDK bootstrap
role ARNs. Replace these with your actual account ID before deploying:

```
arn:aws:iam::ACCOUNT_ID:role/cdk-*-deploy-role-*
```

This prevents the developer from assuming CDK bootstrap roles in other accounts.

### What about the developer's own role?

The developer policy from [iam-policy-user.json](./policies/iam-policy-user.json) does not include `iam:CreateRole` or
any IAM write actions. Developers interact with IAM only indirectly through CloudFormation, which is constrained by the
boundary. If your organization applies permission boundaries to all IAM principals, you can use the developer policy
itself as the boundary, but make sure `sts:AssumeRole` on the CDK bootstrap roles is allowed through it.

## What developers need

If you are a developer (not an admin setting up the account), here is what you need to get started:

1. **AWS credentials** configured in your environment (`aws configure`, environment variables, or SSO). Your admin
   should have attached the AgentCore user policy to your IAM role.

2. **CDK bootstrap** must have been run in your target account and region. If you see an error about the `CDKToolkit`
   stack not existing when you run `agentcore deploy`, ask your admin to bootstrap the account or do it yourself if you
   have the required permissions.

3. **That's it.** The CLI handles the rest. Run `agentcore create` to start a new project and `agentcore deploy` to ship
   it.

## Troubleshooting

**"Access Denied" on `sts:AssumeRole` during deploy.** The developer's policy is missing the CDK bootstrap role
assumption statement, or the bootstrap roles have a trust policy that does not include the developer's role. Check both
sides.

**"Access Denied" during CloudFormation stack creation/update.** The CFN execution role is scoped down but missing a
required permission. Check the `DescribeStackEvents` output to see which specific API call failed, then add it to the
execution policy and re-bootstrap.

**"CDKToolkit stack not found."** CDK has not been bootstrapped in this account/region. Run `cdk bootstrap` (or ask your
admin to) as described above.

**Deploy succeeds but `invoke` fails with "Access Denied".** The developer policy is missing the
`bedrock-agentcore:InvokeAgentRuntime` action (or `InvokeAgentRuntimeForUser` if passing a user ID). Update the user
policy.

**KMS key creation fails during deploy.** If the project uses identity/credential features, the CLI creates a KMS key
for the token vault. The developer policy needs `kms:CreateKey` and `kms:TagResource`. If your organization restricts
KMS key creation, have an admin pre-create the key and configure it via the token vault settings.

---

# Permissions Reference

The tables below list every IAM action the CLI requires, organized by category. Each entry notes which CLI commands use
the action and why.

## User permissions

These permissions are required on your IAM principal (user or role). They cover everything the CLI calls directly,
outside of CloudFormation.

### CDK bootstrap role assumption

Required for all deployment operations (`deploy`, `status`, `diff`).

| Action           | Resource                                                     |
| ---------------- | ------------------------------------------------------------ |
| `sts:AssumeRole` | `arn:aws:iam::ACCOUNT_ID:role/cdk-*-deploy-role-*`           |
| `sts:AssumeRole` | `arn:aws:iam::ACCOUNT_ID:role/cdk-*-file-publishing-role-*`  |
| `sts:AssumeRole` | `arn:aws:iam::ACCOUNT_ID:role/cdk-*-image-publishing-role-*` |
| `sts:AssumeRole` | `arn:aws:iam::ACCOUNT_ID:role/cdk-*-lookup-role-*`           |

### Core

| Action                          | CLI Commands                         | Purpose                                            |
| ------------------------------- | ------------------------------------ | -------------------------------------------------- |
| `sts:GetCallerIdentity`         | All                                  | Validate AWS credentials, resolve account ID       |
| `cloudformation:DescribeStacks` | `deploy`, `status`                   | Check bootstrap status, stack status, read outputs |
| `tag:GetResources`              | `status`, `deploy`, `invoke`, `logs` | Discover deployed stacks by project tags           |

### Agent invocation

| Action                                        | CLI Commands | Purpose                                                                                   |
| --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `bedrock-agentcore:InvokeAgentRuntime`        | `invoke`     | Invoke deployed agents (HTTP, MCP, and A2A protocols)                                     |
| `bedrock-agentcore:InvokeAgentRuntimeForUser` | `invoke`     | Invoke agents with a user ID (requires `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` header) |
| `bedrock-agentcore:StopRuntimeSession`        | `invoke`     | End an agent runtime session                                                              |

### Runtime and resource status

| Action                                        | CLI Commands          | Purpose                               |
| --------------------------------------------- | --------------------- | ------------------------------------- |
| `bedrock-agentcore:GetAgentRuntime`           | `status`              | Check agent runtime deployment status |
| `bedrock-agentcore:ListGatewayTargets`        | `status`              | Check MCP gateway target sync status  |
| `bedrock-agentcore:GetEvaluator`              | `status`, `run evals` | Get evaluator details                 |
| `bedrock-agentcore:ListEvaluators`            | `run evals`           | List available evaluators             |
| `bedrock-agentcore:GetOnlineEvaluationConfig` | `status`              | Get online eval config status         |

### Evaluation

| Action                                           | CLI Commands                              | Purpose                                       |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------------------- |
| `bedrock-agentcore:Evaluate`                     | `run evals`                               | Run on-demand evaluation against agent traces |
| `bedrock-agentcore:UpdateOnlineEvaluationConfig` | `pause online-eval`, `resume online-eval` | Pause or resume online evaluation             |

### Identity and credential management

| Action                                             | CLI Commands | Purpose                                   |
| -------------------------------------------------- | ------------ | ----------------------------------------- |
| `bedrock-agentcore:GetApiKeyCredentialProvider`    | `deploy`     | Check if API key provider exists          |
| `bedrock-agentcore:CreateApiKeyCredentialProvider` | `deploy`     | Create API key credential provider        |
| `bedrock-agentcore:UpdateApiKeyCredentialProvider` | `deploy`     | Update API key with new value             |
| `bedrock-agentcore:GetOauth2CredentialProvider`    | `deploy`     | Check if OAuth2 provider exists           |
| `bedrock-agentcore:CreateOauth2CredentialProvider` | `deploy`     | Create OAuth2 credential provider         |
| `bedrock-agentcore:UpdateOauth2CredentialProvider` | `deploy`     | Update OAuth2 provider                    |
| `bedrock-agentcore:GetTokenVault`                  | `deploy`     | Check token vault KMS configuration       |
| `bedrock-agentcore:CreateTokenVault`               | `deploy`     | Create token vault for credential storage |
| `bedrock-agentcore:SetTokenVaultCMK`               | `deploy`     | Configure KMS encryption for token vault  |
| `kms:CreateKey`                                    | `deploy`     | Create KMS key for token vault encryption |
| `kms:TagResource`                                  | `deploy`     | Tag the created KMS key                   |

### Policy generation

| Action                                         | CLI Commands      | Purpose                          |
| ---------------------------------------------- | ----------------- | -------------------------------- |
| `bedrock-agentcore:StartPolicyGeneration`      | Policy generation | Start Cedar policy generation    |
| `bedrock-agentcore:GetPolicyGeneration`        | Policy generation | Poll generation status           |
| `bedrock-agentcore:ListPolicyGenerationAssets` | Policy generation | Retrieve generated policy assets |

### Logging, traces, and observability

| Action                          | CLI Commands                             | Purpose                                       |
| ------------------------------- | ---------------------------------------- | --------------------------------------------- |
| `logs:StartLiveTail`            | `logs`                                   | Stream agent logs in real-time                |
| `logs:FilterLogEvents`          | `logs`                                   | Search agent logs                             |
| `logs:StartQuery`               | `traces list`, `traces get`, `run evals` | Run CloudWatch Logs Insights queries          |
| `logs:GetQueryResults`          | `traces list`, `traces get`, `run evals` | Retrieve query results                        |
| `logs:DescribeResourcePolicies` | `deploy`                                 | Check for X-Ray log resource policy           |
| `logs:PutResourcePolicy`        | `deploy`                                 | Create resource policy for X-Ray trace access |

### Transaction search setup

Called during `deploy` to enable CloudWatch Transaction Search for tracing.

| Action                               | CLI Commands | Purpose                              |
| ------------------------------------ | ------------ | ------------------------------------ |
| `application-signals:StartDiscovery` | `deploy`     | Enable Application Signals discovery |
| `xray:GetTraceSegmentDestination`    | `deploy`     | Check current trace destination      |
| `xray:UpdateTraceSegmentDestination` | `deploy`     | Route traces to CloudWatch Logs      |
| `xray:UpdateIndexingRule`            | `deploy`     | Set trace indexing sampling rate     |

### Bedrock agent import

Only required when using `agentcore add agent --type import` to import an existing Bedrock Agent.

| Action                            | CLI Commands              | Purpose                       |
| --------------------------------- | ------------------------- | ----------------------------- |
| `bedrock:GetFoundationModel`      | `add agent --type import` | Get model metadata            |
| `bedrock:GetGuardrail`            | `add agent --type import` | Get guardrail configuration   |
| `bedrock:ListAgents`              | `add agent --type import` | List Bedrock Agents in region |
| `bedrock:ListAgentAliases`        | `add agent --type import` | List agent aliases            |
| `bedrock:GetAgent`                | `add agent --type import` | Get agent configuration       |
| `bedrock:GetAgentAlias`           | `add agent --type import` | Get alias details             |
| `bedrock:ListAgentActionGroups`   | `add agent --type import` | List agent action groups      |
| `bedrock:GetAgentActionGroup`     | `add agent --type import` | Get action group details      |
| `bedrock:ListAgentKnowledgeBases` | `add agent --type import` | List knowledge bases          |
| `bedrock:GetKnowledgeBase`        | `add agent --type import` | Get knowledge base details    |
| `bedrock:ListAgentCollaborators`  | `add agent --type import` | List collaborator agents      |
| `s3:GetObject`                    | `add agent --type import` | Fetch S3-stored API schemas   |

### Bedrock model invocation

| Action                | CLI Commands            | Purpose                                       |
| --------------------- | ----------------------- | --------------------------------------------- |
| `bedrock:InvokeModel` | `add` (code generation) | Invoke Claude for AI-assisted code generation |

## CFN execution role permissions

These permissions are needed on the CloudFormation execution role (`cdk-*-cfn-exec-role-*`), not on your user. If your
account uses the default CDK bootstrap with `AdministratorAccess`, this section is informational only.

If your organization scopes down the execution role, include the following. Note that the provided
[iam-policy-cfn-execution.json](./policies/iam-policy-cfn-execution.json) uses `bedrock-agentcore:*` as a convenience so
you don't need to update the policy each time a new AgentCore resource type is added. The tables below list the specific
actions used today.

### Bedrock AgentCore resources

| Action                                                                                                                                        | Resource Type Created                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `bedrock-agentcore:CreateRuntime`, `UpdateRuntime`, `DeleteRuntime`, `GetRuntime`                                                             | `AWS::BedrockAgentCore::Runtime`                |
| `bedrock-agentcore:CreateMemory`, `UpdateMemory`, `DeleteMemory`, `GetMemory`                                                                 | `AWS::BedrockAgentCore::Memory`                 |
| `bedrock-agentcore:CreateGateway`, `UpdateGateway`, `DeleteGateway`, `GetGateway`                                                             | `AWS::BedrockAgentCore::Gateway`                |
| `bedrock-agentcore:CreateGatewayTarget`, `UpdateGatewayTarget`, `DeleteGatewayTarget`, `GetGatewayTarget`                                     | `AWS::BedrockAgentCore::GatewayTarget`          |
| `bedrock-agentcore:CreateEvaluator`, `UpdateEvaluator`, `DeleteEvaluator`, `GetEvaluator`                                                     | `AWS::BedrockAgentCore::Evaluator`              |
| `bedrock-agentcore:CreateOnlineEvaluationConfig`, `UpdateOnlineEvaluationConfig`, `DeleteOnlineEvaluationConfig`, `GetOnlineEvaluationConfig` | `AWS::BedrockAgentCore::OnlineEvaluationConfig` |
| `bedrock-agentcore:CreatePolicyEngine`, `UpdatePolicyEngine`, `DeletePolicyEngine`, `GetPolicyEngine`                                         | `AWS::BedrockAgentCore::PolicyEngine`           |
| `bedrock-agentcore:CreatePolicy`, `UpdatePolicy`, `DeletePolicy`, `GetPolicy`                                                                 | `AWS::BedrockAgentCore::Policy`                 |

### IAM

| Action                                                           | Purpose                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `iam:CreateRole`, `iam:DeleteRole`, `iam:GetRole`                | Execution roles for runtimes, memories, gateways, evaluators |
| `iam:PassRole`                                                   | Allow services to assume created roles                       |
| `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:GetRolePolicy` | Inline policies on execution roles                           |
| `iam:AttachRolePolicy`, `iam:DetachRolePolicy`                   | Managed policies (e.g., `AWSLambdaBasicExecutionRole`)       |
| `iam:TagRole`, `iam:UpdateAssumeRolePolicy`                      | Role tagging and trust policy updates                        |

### S3 (CDK asset staging)

| Action                                                            | Purpose                    |
| ----------------------------------------------------------------- | -------------------------- |
| `s3:CreateBucket`, `s3:PutBucketPolicy`, `s3:PutBucketVersioning` | Bootstrap bucket setup     |
| `s3:PutEncryptionConfiguration`, `s3:PutLifecycleConfiguration`   | Bucket configuration       |
| `s3:PutBucketPublicAccessBlock`                                   | Security configuration     |
| `s3:GetBucketLocation`, `s3:GetObject`, `s3:PutObject`            | Asset upload and retrieval |
| `s3:ListBucket`, `s3:DeleteObject`                                | Asset management           |

### KMS

| Action                                                                | Purpose                              |
| --------------------------------------------------------------------- | ------------------------------------ |
| `kms:CreateKey`, `kms:CreateAlias`, `kms:DescribeKey`                 | Encryption keys for ECR repos and S3 |
| `kms:PutKeyPolicy`, `kms:GetKeyPolicy`                                | Key policy management                |
| `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`                   | Cryptographic operations             |
| `kms:TagResource`, `kms:ScheduleKeyDeletion`, `kms:EnableKeyRotation` | Key lifecycle                        |

### CloudFormation

| Action                                                                                                                                    | Purpose               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `cloudformation:CreateStack`, `cloudformation:UpdateStack`, `cloudformation:DeleteStack`                                                  | Stack lifecycle       |
| `cloudformation:DescribeStacks`, `cloudformation:DescribeStackEvents`                                                                     | Stack status          |
| `cloudformation:GetTemplate`                                                                                                              | Template retrieval    |
| `cloudformation:CreateChangeSet`, `cloudformation:ExecuteChangeSet`, `cloudformation:DeleteChangeSet`, `cloudformation:DescribeChangeSet` | Change set operations |
| `cloudformation:ListStacks`                                                                                                               | Stack discovery       |

### SSM Parameter Store

| Action              | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `ssm:GetParameters` | CDK bootstrap version lookup (`/cdk-bootstrap/*/version`) |

### ECR (container builds only)

| Action                                                                                      | Purpose                  |
| ------------------------------------------------------------------------------------------- | ------------------------ |
| `ecr:CreateRepository`, `ecr:DeleteRepository`, `ecr:DescribeRepositories`                  | Repository lifecycle     |
| `ecr:GetAuthorizationToken`                                                                 | Docker authentication    |
| `ecr:BatchGetImage`, `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`        | Image pull               |
| `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` | Image push               |
| `ecr:SetRepositoryPolicy`, `ecr:PutLifecyclePolicy`, `ecr:PutImageScanningConfiguration`    | Repository configuration |
| `ecr:TagResource`                                                                           | Tagging                  |

### CodeBuild (container builds only)

| Action                                                                           | Purpose                 |
| -------------------------------------------------------------------------------- | ----------------------- |
| `codebuild:CreateProject`, `codebuild:DeleteProject`, `codebuild:UpdateProject`  | Build project lifecycle |
| `codebuild:StartBuild`, `codebuild:BatchGetBuilds`, `codebuild:BatchGetProjects` | Build execution         |

### Lambda (MCP Lambda compute and container build orchestration)

| Action                                                            | Purpose                            |
| ----------------------------------------------------------------- | ---------------------------------- |
| `lambda:CreateFunction`, `lambda:DeleteFunction`                  | Function lifecycle                 |
| `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration` | Function updates                   |
| `lambda:GetFunction`, `lambda:GetFunctionConfiguration`           | Function reads                     |
| `lambda:InvokeFunction`                                           | Custom resource handler invocation |
| `lambda:AddPermission`, `lambda:RemovePermission`                 | Resource-based policies            |
| `lambda:TagResource`                                              | Tagging                            |

### CloudWatch Logs

| Action                                              | Purpose                 |
| --------------------------------------------------- | ----------------------- |
| `logs:CreateLogGroup`, `logs:DeleteLogGroup`        | Log group lifecycle     |
| `logs:CreateLogStream`, `logs:PutLogEvents`         | Log writing             |
| `logs:DescribeLogGroups`, `logs:PutRetentionPolicy` | Log group configuration |
| `logs:TagResource`                                  | Tagging                 |

### Secrets Manager

| Action                                                           | Purpose                                   |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `secretsmanager:CreateSecret`, `secretsmanager:DeleteSecret`     | Secret lifecycle for credential providers |
| `secretsmanager:DescribeSecret`, `secretsmanager:GetSecretValue` | Secret reads                              |
| `secretsmanager:PutSecretValue`                                  | Secret writes                             |
| `secretsmanager:TagResource`                                     | Tagging                                   |

## Policy JSON files

Ready-to-use IAM policy documents are provided alongside this guide:

- [iam-policy-user.json](./policies/iam-policy-user.json) -- Attach to your IAM user or role. Covers all direct SDK
  calls and CDK bootstrap role assumption. Replace `ACCOUNT_ID` with your account number.
- [iam-policy-cfn-execution.json](./policies/iam-policy-cfn-execution.json) -- Use as the CloudFormation execution role
  policy if your organization scopes down the default `AdministratorAccess`. Includes deny statements to enforce
  permission boundaries. Replace `ACCOUNT_ID` with your account number. Pass it during bootstrap with
  `--cloudformation-execution-policies`.
- [iam-policy-boundary.json](./policies/iam-policy-boundary.json) -- Permission boundary for execution roles created
  during deployment. Caps what agent runtimes, memories, and gateways can do at runtime (model access, logging,
  tracing). Replace `ACCOUNT_ID` with your account number. See
  [Hardening with permission boundaries](#hardening-with-permission-boundaries).
