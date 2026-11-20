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
one, they skip. box ships only arm64 builds, so in CI only the macOS runner (Apple silicon) and the
Linux arm64 runner (`ubuntu-24.04-arm`, which runs only the Box tests) have one: each installs the
box that `src/core/project/backends/boxRelease.json` pins. `create` also installs the agent's dependencies and the CDK app's, which `dev` and
`deploy` use, so the tests don't pass `--skip-install`.

The tests that deploy also need `AGENTCORE_E2E_BOX_CDK`: the pinned `@aws/agentcore-cdk` release
cannot deploy a Box project yet. Set it to an `@aws/agentcore-cdk` version or a `file:` tarball
that can, for example one packed from the `box-integration` branch of
[agentcore-l3-cdk-constructs](https://github.com/aws/agentcore-l3-cdk-constructs) with
`npm run build && npm pack --ignore-scripts`. The tests install it in each Box project's
`agentcore/cdk`. Without it, as in CI, they skip.

The `dev` tests also need a machine where `box run` can start its sandbox, and for the container
template a container tool. Box listens on the protocol's fixed port (8080, 8000 or 9000), so the
`dev` tests run one at a time and need those ports free:

```sh
AGENTCORE_E2E_BOX_CDK=file:/path/to/aws-agentcore-cdk-1.1.0.tgz bun run test:e2e -- --tagsFilter='box'
```

That runs each Box template on its default Python. The CodeZip box template on Python 3.10 to 3.13
(`py_strands_box_3_10` to `py_strands_box_3_13`) is in the runtime templates describe, so it runs
with `--tagsFilter='runtime'` or a full run, given `box` and the same opt-in. Those four cases
pass only once box runs CodeZip agents without the ffi shim (#2867): until then `boxRelease.json`
pins a shim for `PYTHON_3_14` only, so they fail on any machine.

The `box-egress` test checks that box, under `agentcore dev`, lets the agent reach the host its
profile allows (`checkip.amazonaws.com`) and blocks any other (`example.com`). It reaches public
hosts, so the network can make it fail. It retries twice, and `--tagsFilter='box'` leaves it out:

```sh
bun run test:e2e -- --tagsFilter='box-egress'
```
