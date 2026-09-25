# End-to-end tests

The e2e suite deploys and invokes real AgentCore resources. Run it with AWS credentials:

```sh
bun install
bun run build
export AGENTCORE_CLI_PATH="node $PWD/dist/index.js"
bun run test:e2e
```

Local `dev` for container templates (for example `agent-python-strands-container`) needs a
container runtime with a reachable daemon (Docker, Podman, or Finch). Without one, their
"runs locally" cases are skipped; deploy and cloud invoke still run.

To run tagged tests:

```sh
bun run test:e2e -- --tagsFilter='runtime || canary'
```

Set `AGENTCORE_CLI_PATH` to use a different executable:

```sh
AGENTCORE_CLI_PATH=/path/to/agentcore bun run test:e2e
```
