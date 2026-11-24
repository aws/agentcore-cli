# ContainerLocal assembly fixture

A real cloud assembly synthesized by `@aws/agentcore-cdk` with ContainerLocal support
(aws/agentcore-l3-cdk-constructs#463). `localImages.test.ts` reads it to pin the contract between
the CDK package and `agentcore build`: each stack template's `Metadata["agentcore:localImages"]`
maps `runtime/<name>` or `harness/<name>` to the key of its image under `dockerImages` in the
stack's asset manifest.

The project had no deployment targets, so it synthesized one environment-agnostic stack,
`AgentCore-Fixture`, with:

- Runtime `orders`: `build: ContainerLocal`
- Runtime `billing`: `build: Container` (CodeBuild)
- Harness `assistant`: `build: ContainerLocal`, `dockerfile: Dockerfile`

Only `manifest.json`, the stack template, and the asset manifest are kept. The staged `asset.*`
directories, `tree.json`, and the stack's `*.metadata.json`, which `manifest.json` still
references, are not needed by the CLI and are not included.

## Regenerating

1. In a checkout of aws/agentcore-l3-cdk-constructs with ContainerLocal support, run
   `npm run build && npm pack`.
2. Create an AgentCore project (no `aws-targets.json` entries) with the three workloads above.
3. In its `agentcore/cdk/` directory, install the packed tarball together with the
   `aws-cdk-lib` and `constructs` versions it requires, then synthesize the vended app
   (`npx cdk synth`, or run the compiled `bin/cdk` app with `CDK_OUTDIR` set).
4. Copy `manifest.json`, `AgentCore-Fixture.template.json`, and `AgentCore-Fixture.assets.json`
   from the output directory into this directory.
