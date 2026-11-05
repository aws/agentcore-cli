# Pre-built container images for Runtime deployments

Status: design proposal

Tracking issue: aws/agentcore-cli#503

## Summary

Allow an AgentCore Runtime with `build: "Container"` to reference an image that already exists
in ECR. When a pre-built image is configured, deployment must create or update the Runtime
directly from that image without uploading source, creating a managed ECR repository, or running
CodeBuild.

The image should be modeled as Runtime configuration rather than passed to the generated CDK app
through an environment variable. This keeps `agentcore build`, `agentcore deploy`, and direct CDK
synthesis deterministic and gives every Runtime in a multi-Runtime project an unambiguous image
source.

## Goals

- Deploy a private or public ECR image without invoking CodeBuild.
- Reject malformed ECR image URIs before CDK synthesis.
- Preserve the existing Dockerfile-to-CodeBuild deployment path.
- Support projects containing more than one Runtime.
- Keep the generated CDK application as a thin `AgentCoreApplication` instantiator.
- Preserve the Runtime ID, ARN, role ARN, and endpoint output contracts.

## Non-goals

- Building or copying images between registries, accounts, or regions.
- Verifying that an image or tag exists before deployment.
- Managing repository policies for a customer-owned cross-account ECR repository.
- Selecting a different image URI for each deployment target.
- Introducing a general-purpose deployment override system.
- Removing the existing CodeBuild-based container workflow.

## Proposed project configuration

Add an optional `containerUri` field to a Runtime:

```json
{
  "name": "my_agent",
  "build": "Container",
  "entrypoint": "main.py",
  "codeLocation": "app/my_agent",
  "containerUri": "123456789012.dkr.ecr.us-west-2.amazonaws.com/my-agent:abc123"
}
```

For the initial implementation, `entrypoint` and `codeLocation` remain required by the existing
Runtime schema for compatibility, but their local files are not build inputs when `containerUri`
is set.

A Container Runtime has exactly one image source:

1. `containerUri` is set: deploy the referenced image directly.
2. `containerUri` is not set: retain the existing Dockerfile, CodeBuild, and managed ECR path.

`containerUri` is valid only with `build: "Container"` and is mutually exclusive with:

- `dockerfile`
- `buildContextPath`
- `customDockerBuildArgs`

An explicitly configured `containerUri` also prevents Runtime build synchronization from inferring
a Dockerfile merely because one exists in the code directory.

Because the field belongs to the Runtime specification, the same URI applies to every deployment
target. The image must therefore be accessible to each target. A target-specific image mapping can
be designed separately if that becomes a supported requirement.

## CLI behavior

The Runtime schema remains the source of truth. The initial implementation does not add an
environment-variable override such as `AGENTCORE_CONTAINER_URI`.

The exact `agentcore deploy --container-uri` interface originally proposed by #503 is ambiguous
for projects with multiple Runtimes. If a deploy-time convenience override is added later, it
should require a Runtime selector:

```text
agentcore deploy --runtime my_agent --container-uri <uri>
```

That override would be separate follow-up work because it must be passed to synthesis without
silently changing `agentcore.json` or making direct CDK synthesis produce a different template.

## Validation and deployment preparation

The CLI and CDK package maintain mirrored Runtime schemas, so both must enforce the same rules:

- Accept only supported private ECR and `public.ecr.aws` image URI formats.
- Enforce the service maximum URI length.
- Reject `containerUri` on a CodeZip Runtime.
- Reject local container-build fields when `containerUri` is present.

Runtime preparation must skip these CodeBuild-specific checks for a pre-built image:

- Dockerfile existence and path validation.
- Local container build-context validation.
- The CodeBuild VPC ID requirement.
- CodeBuild's five-security-group limit.

Runtime networking validation still applies because it configures the deployed Runtime, not the
image build.

## CDK design

Branch in `RuntimeEnvironment`, where Runtime artifact construction is already owned:

```text
build = CodeZip
  -> existing bundled-code path

build = Container and containerUri is set
  -> AgentCoreRuntime from the existing image

build = Container and containerUri is not set
  -> existing source asset -> CodeBuild -> managed ECR path
```

The pre-built path must not create:

- `ContainerSourceAsset`
- `ContainerRepository`
- `ContainerBuildProject`
- `ContainerImageBuilder`

`AgentCoreRuntime` already supports a container URI, but its ECR access logic currently expects the
managed repository ARN supplied by the build path. For a private pre-built URI, the construct must
derive the repository ARN and grant the Runtime execution role:

- `ecr:GetAuthorizationToken`
- `ecr:BatchGetImage`
- `ecr:GetDownloadUrlForLayer`
- `ecr:BatchCheckLayerAvailability`

Public ECR images must not require a private repository ARN. Cross-account private repositories may
also need a customer-managed repository policy; the CLI does not modify an external repository.

Runtime and endpoint outputs are already emitted after artifact selection, so their logical IDs and
export names remain unchanged.

## Compatibility

- Existing CodeZip deployments are unchanged.
- Existing Container deployments without `containerUri` continue through CodeBuild.
- Existing project files remain valid.
- The generated CDK stack continues to instantiate `AgentCoreApplication`; branching stays inside
  `@aws/agentcore-cdk`.
- The CDK package change must be released before the CLI updates its generated project dependency.

## Test plan

CLI:

- Accept valid private and public ECR image URIs.
- Reject invalid URI formats and over-length values.
- Reject incompatible Runtime fields.
- Do not infer or validate a Dockerfile when `containerUri` is configured.
- Do not apply CodeBuild-only VPC restrictions to a pre-built image.
- Preserve the existing Dockerfile synchronization and validation tests.

CDK:

- A pre-built image synthesizes the expected Runtime `ContainerUri`.
- The pre-built path synthesizes no CodeBuild, managed ECR, source asset, or build custom resource.
- A private ECR URI produces repository-scoped pull permissions.
- Public ECR does not require a private repository ARN.
- Dockerfile-based Container deployment remains unchanged.
- Runtime ID, ARN, role ARN, endpoint, and output export-name contracts remain unchanged.

End-to-end:

- Push an ARM64 Runtime image to ECR.
- Deploy a project referencing that image.
- Confirm no CodeBuild build starts.
- Wait for the Runtime to become ready and invoke it.
- Repeat with an ordinary Dockerfile Runtime as the regression case.

## Delivery sequence

1. Add schema, branching, IAM, and tests to `@aws/agentcore-cdk`.
2. Publish the compatible CDK package.
3. Add the mirrored CLI schema and Runtime preparation behavior.
4. Update the generated CDK dependency and command/configuration documentation.
5. Run the Runtime container end-to-end deployment tests.
