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
are optional: they run only when a `box` runs from your PATH, and skip otherwise. Create, build and
deploy of a Box template run `box`, and box ships only arm64 builds, so they skip on the x86_64 Linux
CI runner. The `dev` tests also need a machine where `box run` can start its sandbox. Box listens on
the protocol's fixed port (8080, 8000 or 9000), so the `dev` tests run one at a time and need those
ports free:

```sh
bun run test:e2e -- --tagsFilter='box'
```

The `box-egress` test checks that box, under `agentcore dev`, lets the agent reach the host its
profile allows (`checkip.amazonaws.com`) and blocks any other (`example.com`). It reaches public
hosts, so the network can make it fail. It retries twice, and `--tagsFilter='box'` leaves it out:

```sh
bun run test:e2e -- --tagsFilter='box-egress'
```
