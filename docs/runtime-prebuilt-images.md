# Deploy an existing Runtime image

Set `containerUri` in `--build-config` on `agentcore add runtime` to deploy an image you have
already built and pushed to ECR:

```sh
agentcore add runtime --name agent \
  --build-config '{"containerUri":"123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1"}'
agentcore deploy
agentcore invoke --runtime agent --payload '{"prompt":"Hello"}'
```

Private ECR tags and digests, and public ECR image URIs, are supported. The image must satisfy the
AgentCore Runtime contract, including Linux ARM64 and the selected protocol's server requirements.
The toolkit does not build, copy, publish, or check the existence of this image.

`--build-config` keys match `agentcore.json`. With `containerUri`:

- `build` must be `"Container"`; when omitted, the CLI writes `"build": "Container"`. `CodeZip` and
  `ContainerLocal` are rejected.
- `dockerfile`, `buildContextPath`, and `customDockerBuildArgs` are rejected: the image is not built.
- `--language` is optional. The persisted Runtime keeps schema-required `entrypoint` and
  `codeLocation` placeholders, but the CLI creates no source folder, and build and deploy do not
  read those placeholders or any local Dockerfile or manifest.

All other `add runtime` flags (`--protocol`, `--network-mode`, `--environment-variables`, and so
on) work as usual.

`agentcore build` synthesizes the deployment and builds nothing locally. `agentcore deploy` uses the
configured URI directly and grants the Runtime execution role the applicable ECR pull permissions.
Neither command creates a managed ECR repository, CodeBuild project, source archive, or
image-build custom resource for this Runtime. `agentcore dev` cannot run a pre-built image; use
deploy and invoke.

Change `containerUri` in `agentcore/agentcore.json` and deploy to update the image. Use a new tag or
digest to trigger an update; replacing the contents of an unchanged tag does not change the
CloudFormation template. Named endpoints continue to select Runtime versions.

A deployed Runtime keeps its artifact type. Switching a deployed Runtime between a pre-built
`containerUri` and an image the toolkit builds (`Container` or `ContainerLocal`) is allowed, because
both are container artifacts. Switching a deployed Runtime between `CodeZip` and `containerUri`, in
either direction, is rejected before deploy: the service does not allow changing a Runtime's
artifact type. Add a Runtime with a new name instead.

`networkMode: "VPC"` configures the deployed workload. A pre-built image does not require
`networkConfig.vpcId` for CodeBuild and is not subject to CodeBuild's five-security-group check.
Runtime networking must still satisfy VPC and account limits, including the security-groups-per-ENI
quota. This setting does not restrict inbound invocation to private endpoints.
The deployed workload still needs the [documented VPC networking prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-vpc-endpoints),
including ECR and S3 connectivity for container images.

This feature requires an `@aws/agentcore-cdk` package that includes CDK PR #440. Older packages can
silently strip unknown schema properties, so before building or deploying, the CLI checks that the
project's package supports every feature the project uses (pre-built Runtime images,
`ContainerLocal`) and fails with the missing feature named. A package that is installed but fails
to load is reported with its own load error instead. Release the CDK change and update the
vended package pin before releasing the CLI change.
