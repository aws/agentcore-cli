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

The `box` tests deploy the Strands Box templates, which run their agent in a box on AgentCore
Runtime. They need `box` on your PATH, because `agentcore create` checks for it, and they skip
`agentcore dev`:

```sh
bun run test:e2e -- --tagsFilter='box'
```

That runs each Box template on its default Python. The CodeZip box template on Python 3.10 to 3.13
(`py_strands_box_3_10` to `py_strands_box_3_13`) is in the runtime templates describe, so it runs
with `--tagsFilter='runtime'` or a full run, outside CI.
