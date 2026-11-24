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

The `box` tests cover the Strands Box templates, which run their agent in a box. They deploy and
invoke each one on AgentCore Runtime, and run `agentcore dev` with one local invoke for each. They
are optional and need a `box` on your PATH: `create` checks for one for a CodeZip box template, and
`build` and `deploy` run `box profile show` for every Box template, the container one too. Without
one, they skip. box ships only arm64 builds, so in CI only the Linux arm64 runner
(`ubuntu-24.04-arm`) has one: it installs the box that `src/core/project/backends/boxRelease.json`
pins. The macOS runner (Apple silicon) is left out for now, because the pinned macOS box build is
killed as soon as it starts (`Killed: 9`), so there the Box tests skip. `create` also installs the agent's dependencies
and the CDK app's, which `dev` and `deploy` use, so the tests don't pass `--skip-install`.

The tests that deploy also need `AGENTCORE_E2E_BOX_CDK`: the pinned `@aws/agentcore-cdk` release
cannot deploy a Box project yet. Set it to an `@aws/agentcore-cdk` version or a `file:` tarball
that can, for example one packed from the `box-integration` branch of
[agentcore-l3-cdk-constructs](https://github.com/aws/agentcore-l3-cdk-constructs) with
`npm run build && npm pack --ignore-scripts`. The tests install it in the `agentcore/cdk` of each
Box project that deploys. Without it, they skip. In CI, the Linux arm64 runner sets it to a
tarball they build from agentcore-l3-cdk-constructs at the workflow's `l3Ref` input (default
`box-integration`), checked out with a read-only token from the repository's GitHub App. Remove
those steps once a released `@aws/agentcore-cdk` deploys Box projects and the pin is bumped. CI
also skips `agent_python_langchain_box` in the deploy tests: its AgentCore Runtime logs hold
OpenTelemetry's `Failed to detach context` at ERROR level, which the log check refuses.

The `dev` tests also need a machine where `box run` can start its sandbox, and for the container
template a container tool. The container template's `dev` test skips when no `docker`, `podman`
or `finch` runs from PATH; in CI, the Linux arm64 runner runs it. A tool that
is installed but stopped, such as Docker Desktop, still counts, so that test then fails. Box
listens on the protocol's fixed port (8080, 8000 or 9000), so the `dev` tests run one at a time
and need those ports free:

```sh
AGENTCORE_E2E_BOX_CDK=file:/path/to/aws-agentcore-cdk-1.1.0.tgz bun run test:e2e -- --tagsFilter='box'
```

That runs each Box template on its default Python. The CodeZip box template on Python 3.10 to 3.13
(`py_strands_box_3_10` to `py_strands_box_3_13`) is in the runtime templates describe, so it runs
with `--tagsFilter='runtime'` or a full run, given `box` and the same opt-in.

The `box-egress` tests check that box lets the agent reach the host its profile allows
(`checkip.amazonaws.com`) and blocks any other (`example.com`): one under `agentcore dev`, and one
on AgentCore Runtime, where the allowed host's calls go through the runtime's Box gateway. The
second deploys, so it also needs `AGENTCORE_E2E_BOX_CDK`. They reach public hosts, so the network
can make them fail: the dev test retries twice, and the deployed one retries only its invoke.
`--tagsFilter='box'` leaves them out. A full run includes them; in CI they run on the Linux arm64
runner:

```sh
bun run test:e2e -- --tagsFilter='box-egress'
```
