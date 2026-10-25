# Existing roles for container builds

Add a container runtime using centrally provisioned IAM roles:

```sh
agentcore add runtime --name worker --language python \
  --role-arn arn:aws:iam::111122223333:role/Runtime \
  --container-build-role-arn arn:aws:iam::111122223333:role/CodeBuild \
  --container-build-handler-role-arn arn:aws:iam::111122223333:role/BuildHandler
```

The runtime entry in `agentcore/agentcore.json` retains `executionRoleArn`,
`containerBuildRoleArn`, and `containerBuildHandlerRoleArn`. Build roles are
optional and only apply to Container runtimes. Supplying either build-role flag
registers a Container build. Add your code and a `Dockerfile` in `app/worker/`
before building or deploying; `add runtime` creates documentation only. Omitted roles keep automatic role
creation. Region partitions and IAM role paths are supported.

## CDK dependency

This feature requires corresponding support in `@aws/agentcore-cdk`. Version
`1.0.0` does not include it. The CLI rejects build and deploy operations with
configured build roles when the installed CDK schema lacks those fields, before
provisioning credentials or synthesizing a stack. It never silently falls back
to creating roles.

The [published-package patch](patches/agentcore-cdk-1.0.0-container-build-roles.patch)
and [verification script](patches/verify-container-build-roles.cjs) are a maintainer
handoff for the private CDK source repository. They target the published
`1.0.0` package, rather than its inaccessible TypeScript source. Maintainers
should port the changes to `ContainerBuildProject`, `ContainerImageBuilder`,
`RuntimeEnvironment`, and the runtime schema, regenerate declarations and source
maps, and publish a release before enabling this feature in deployed projects.

For local verification, extract two copies of that npm package as `original` and
`patched`, install its dependencies, then run:

```sh
patch -d patched -p1 < docs/patches/agentcore-cdk-1.0.0-container-build-roles.patch
node docs/patches/verify-container-build-roles.cjs original patched
```

The script performs local synthesis and validation. It checks unchanged default
templates, role ARNs, absence of generated IAM roles and policies when all roles
are supplied, partial configuration, shared-project conflicts in both creation
orders, separate VPC projects, and rejection of build roles on CodeZip runtimes.
It does not deploy resources.

## Permissions supplied by the role owner

Imported roles are immutable. Their trust policies and permissions must already
allow the operations below; the constructs do not add policies to them.

| Role          | Trusted service                   | Required permissions                                                                                                                                                                                                               |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | `bedrock-agentcore.amazonaws.com` | Normal runtime execution permissions, including image access and the services the agent uses. See the [runtime execution role guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html).      |
| CodeBuild     | `codebuild.amazonaws.com`         | `ecr:GetAuthorizationToken` on `*`; pull/push actions on the runtime ECR repository; read/list access to the S3 source asset and decrypt access if its key requires it; create/write the build's CloudWatch log group and streams. |
| Build handler | `lambda.amazonaws.com`            | `codebuild:StartBuild` and `codebuild:BatchGetBuilds` on the shared build project; create/write its CloudWatch log group and streams.                                                                                              |

For VPC builds, the CodeBuild role also needs EC2 network-interface creation,
deletion and describe actions, plus `ec2:CreateNetworkInterfacePermission` scoped
to the selected subnets and CodeBuild service. The handler needs the equivalent
of `AWSLambdaVPCAccessExecutionRole`. Network egress must reach CodeBuild,
CloudWatch Logs, ECR, S3, and the CloudFormation response URL.

Runtimes sharing the same build network share a CodeBuild project and must specify
the same `containerBuildRoleArn`, including whether it is omitted. Conflicts are
rejected regardless of runtime order. Each runtime has its own build handler and
may use a different handler role. Distinct build networks may use different
CodeBuild roles.

CDK bootstrap infrastructure is provisioned separately. Other resources in the
project, such as harnesses, may require additional roles of their own.
