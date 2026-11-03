# Deploy an existing Runtime image

Use `--advanced-configuration` on `agentcore add runtime` to configure an image you have already
built and pushed to ECR:

```sh
agentcore add runtime --name agent \
  --advanced-configuration '{"containerUri":"123456789012.dkr.ecr.us-west-2.amazonaws.com/agent:v1"}'
agentcore deploy
agentcore invoke --runtime agent --payload '{"prompt":"Hello"}'
```

Private ECR tags and digests, and public ECR image URIs, are supported. The image must satisfy the
AgentCore Runtime contract, including Linux ARM64 and the selected protocol's server requirements.
The toolkit does not build, copy, publish, or check the existence of this image.

The flag accepts one JSON object. Keys use the same camelCase names and values as `agentcore.json`:

- `containerUri`, `description`, `executionRoleArn`, `additionalPolicies`
- `envVars` (an array of `{ "name": "...", "value": "..." }` objects)
- `networkMode`, `networkConfig`
- `authorizerType`, `authorizerConfiguration`
- `protocol`, `requestHeaderAllowlist`
- `lifecycleConfiguration`, `filesystemConfigurations`, `tags`

Unknown keys, invalid values, and a setting supplied both in this object and through an existing
standalone flag are rejected before the project is changed. Existing standalone flags continue to
work. Basic options such as `--name`, `--language`, and Bedrock Agent import selectors stay outside
this object. There is no global deploy override.

An existing image does not need `--language`. The persisted Runtime still has `build: "Container"`
and schema-required `entrypoint` and `codeLocation` placeholders. The CLI creates no source folder,
and build/deploy do not read those placeholders or any local Dockerfile or manifest.

`agentcore build` synthesizes the deployment. `agentcore deploy` uses the configured URI directly
and grants the Runtime execution role the applicable ECR pull permissions. Neither command
creates a managed ECR repository, CodeBuild project, source archive, or image-build custom resource
for this Runtime. `agentcore dev` requires a Runtime with local source; use deploy/invoke for an
existing image.

Change `containerUri` in `agentcore/agentcore.json` and deploy to update the image. Use a new tag or
digest to trigger an update; replacing the contents of an unchanged tag does not change the
CloudFormation template. Named endpoints continue to select Runtime versions.

`networkMode: "VPC"` configures the deployed workload. A pre-built image does not require
`networkConfig.vpcId` for CodeBuild and is not subject to CodeBuild's five-security-group check.
Runtime networking must still satisfy VPC and account limits, including the security-groups-per-ENI
quota. This setting does not restrict inbound invocation to private endpoints.
The deployed workload still needs the [documented VPC networking prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-vpc-endpoints),
including ECR and S3 connectivity for container images. Skipping CodeBuild removes the remote
package-installation step; it does not remove the Runtime's image-pull networking requirements.

This feature requires a released `@aws/agentcore-cdk` package containing CDK PR #440. Older packages
can silently strip unknown schema properties; the CLI now detects that condition and fails before
deployment instead of accidentally choosing CodeBuild. Release the CDK change and update the
vended package pin before releasing the CLI change.

The Dockerfile/CodeBuild deployment path remains the default. Toolkit-managed local builds and
private-only invocation are separate proposals.
