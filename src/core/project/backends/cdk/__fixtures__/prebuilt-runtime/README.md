# Pre-built Runtime assembly fixture

A real cloud assembly synthesized by `@aws/agentcore-cdk` with ContainerLocal
(aws/agentcore-l3-cdk-constructs#463) and Runtime `containerUri` (#440) support, from the
`agentcore.json` in this directory. Tests read it to pin how the CDK package records a pre-built
image Runtime: `"runtime/image": "ContainerUri"` in `agentcore:builds`, with no
`agentcore:localImages` entry, and the image URI used as is.

The project has no deployment targets, so it synthesized one stack, `AgentCore-Fixture`:

- Runtime `orders`: `build: ContainerLocal`
- Runtime `billing`: `build: Container` (CodeBuild)
- Runtime `image`: `build: Container` with `containerUri`
- Harness `assistant`: `build: ContainerLocal`

Only `agentcore.json`, `manifest.json`, the stack template, and the asset manifest are kept;
`manifest.json` still references `tree.json` and the stack's `*.metadata.json`, which the CLI
does not read.

## Regenerating

1. In a checkout of aws/agentcore-l3-cdk-constructs with both features, run
   `npm run build && npm pack`.
2. Create an AgentCore project with this directory's `agentcore.json` (and empty
   `aws-targets.json`), with a Dockerfile in `app/orders`, `app/billing`, and `app/assistant`, and
   the harness `app/assistant/harness.yaml` (`build: ContainerLocal`, `dockerfile: Dockerfile`).
3. In its `agentcore/cdk/` directory, install the packed tarball with the `aws-cdk-lib` and
   `constructs` versions it requires, and synthesize the vended app.
4. Copy `manifest.json`, `AgentCore-Fixture.template.json`, and `AgentCore-Fixture.assets.json`
   from the output directory here.
