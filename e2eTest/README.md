# End-to-end tests

The e2e suite deploys and invokes real AgentCore resources. Run it with AWS credentials:

```sh
bun install
bun run build
export AGENTCORE_CLI_PATH="node $PWD/dist/index.js"
bun run test:e2e
```

To run tagged tests:

```sh
bun run test:e2e -- --tagsFilter='runtime || canary'
```

Set `AGENTCORE_CLI_PATH` to use a different executable. The value is split on whitespace and is not
run through a shell, so paths containing spaces, quoting, and shell syntax are not supported:

```sh
AGENTCORE_CLI_PATH=/path/to/agentcore bun run test:e2e
```

The pre-built Runtime tests accept existing Linux ARM64 HTTP images. The test handler must return
`{"version":"v1","echo":<request>}` for the initial image and `"v2"` for the update:

```sh
export AGENTCORE_PREBUILT_V1_URI='<private ECR tag URI>'
export AGENTCORE_PREBUILT_V1_DIGEST_URI='<same image by digest>'
export AGENTCORE_PREBUILT_V2_URI='<updated private ECR image>'
# Optional: an existing public ECR image with the v1 handler.
export AGENTCORE_PREBUILT_PUBLIC_URI='<public ECR image URI>'
# Before CDK PR #440 is released, install a locally packed feature package.
export AGENTCORE_CDK_PACKAGE=/absolute/path/to/aws-agentcore-cdk.tgz
bunx vitest run --config vitest.prebuilt.e2e.config.ts
```

These tests skip when their image variables are absent. They exercise the JSON advanced flag,
build/deploy/invoke, digest pinning, a named endpoint, an image update retaining the Runtime ID,
absence of build resources, and stack teardown. They never create or publish the image fixtures.
The focused configuration cleans up only the stacks this suite creates.
