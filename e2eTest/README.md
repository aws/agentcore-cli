# End-to-end tests

The e2e suite deploys and invokes real AgentCore resources. Run it with AWS credentials:

```sh
bun run build
export AGENTCORE_CLI_PATH="node $PWD/dist/index.js"
bun run test:e2e
```

To run tagged tests:

```sh
bun run test:e2e -- --tagsFilter='runtime || canary'
```

Set `AGENTCORE_CLI_PATH` to use a different executable:

```sh
AGENTCORE_CLI_PATH=/path/to/agentcore bun run test:e2e
```
