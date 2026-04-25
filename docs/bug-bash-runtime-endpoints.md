# Runtime Endpoint Support — Bug Bash

## Feature Overview

AgentCore runtimes support multiple endpoints, each associated with a different version. This feature adds the ability
for users to register, manage, and deploy named endpoints (version aliases) for their runtimes via the CLI.

**What are runtime endpoints?** A runtime endpoint is a named alias that points to a specific version of a deployed
runtime. For example, a user might have a runtime `my-agent` at version 5, with:

- `prod` endpoint → version 3 (stable release)
- `staging` endpoint → version 5 (latest)
- `canary` endpoint → version 4 (testing rollback)

This lets teams manage traffic routing and versioning without redeploying the runtime itself.

**What was added:**

- `agentcore add runtime-endpoint` — CLI command + TUI wizard to add an endpoint to a runtime
- `agentcore remove runtime-endpoint` — CLI command + TUI flow to remove an endpoint
- `agentcore status` — endpoints appear nested under their parent agent with deployment state
- `agentcore deploy` — endpoints are deployed as `AWS::BedrockAgentCore::RuntimeEndpoint` CloudFormation resources
- Schema: `endpoints` dictionary on each runtime in `agentcore.json`
- Deployed state: `runtimeEndpoints` section in `deployed-state.json` with endpoint IDs and ARNs

---

## Test Flows

### Flow 1: Add Runtime Endpoint (CLI)

**Goal:** Verify the CLI command correctly adds endpoints to agentcore.json.

| Step | Command                                                                                                          | Expected                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1a   | `agentcore add runtime-endpoint --runtime <agent> --endpoint prod --version 3 --description "Production" --json` | Success JSON, endpoint in agentcore.json |
| 1b   | `agentcore add runtime-endpoint --runtime <agent> --endpoint staging --json`                                     | Success, version defaults to 1           |
| 1c   | `agentcore add runtime-endpoint --runtime NonExistent --endpoint test --json`                                    | Error: runtime not found                 |
| 1d   | `agentcore add runtime-endpoint --runtime <agent> --endpoint prod --json` (duplicate)                            | Error: already exists                    |
| 1e   | `agentcore add runtime-endpoint --runtime <agent> --endpoint "bad name!" --json`                                 | Error: invalid name                      |
| 1f   | `agentcore add runtime-endpoint --runtime <agent> --endpoint test --version 0 --json`                            | Error: version must be >= 1              |

### Flow 2: Add Runtime Endpoint (TUI)

**Goal:** Verify the interactive TUI wizard works correctly.

| Step | Action                                                        | Expected                                                        |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 2a   | `agentcore` → Add → Runtime Endpoint (single runtime project) | Skips runtime selection, goes directly to endpoint form         |
| 2b   | `agentcore` → Add → Runtime Endpoint (multi-runtime project)  | Shows runtime picker first                                      |
| 2c   | In endpoint form, tab between fields                          | All 3 fields visible, active field highlighted in cyan          |
| 2d   | Fill name + version + description → Enter                     | Advances to confirm screen                                      |
| 2e   | Confirm screen shows correct values                           | Runtime, endpoint, version, description displayed               |
| 2f   | Press Enter on confirm                                        | Success screen: "Run `agentcore deploy` to create the endpoint" |
| 2g   | Press Esc on endpoint form                                    | Goes back (to runtime picker or exits)                          |

### Flow 3: Remove Runtime Endpoint (CLI)

**Goal:** Verify the CLI command correctly removes endpoints from agentcore.json.

| Step | Command                                                       | Expected                                          |
| ---- | ------------------------------------------------------------- | ------------------------------------------------- |
| 3a   | `agentcore remove runtime-endpoint --name prod --json`        | Success, endpoint removed from agentcore.json     |
| 3b   | `agentcore remove runtime-endpoint --name nonexistent --json` | Error: not found                                  |
| 3c   | Verify agentcore.json after removal                           | Endpoint gone, other endpoints untouched          |
| 3d   | Remove last endpoint on a runtime                             | `endpoints` key removed entirely (not empty `{}`) |

### Flow 4: Remove Runtime Endpoint (TUI)

**Goal:** Verify the interactive remove flow works.

| Step | Action                                  | Expected                                            |
| ---- | --------------------------------------- | --------------------------------------------------- |
| 4a   | `agentcore` → Remove → Runtime Endpoint | Shows list of endpoints with runtime name + version |
| 4b   | Select an endpoint                      | Shows confirmation screen with details              |
| 4c   | Confirm removal                         | Success screen with deploy reminder                 |
| 4d   | Esc on selection                        | Goes back to resource type picker                   |

### Flow 5: Status Display

**Goal:** Verify endpoints appear correctly in status output.

| Step | Command                                    | Expected                                          |
| ---- | ------------------------------------------ | ------------------------------------------------- |
| 5a   | `agentcore status` (before deploy)         | Endpoints nested under agents with `[Local only]` |
| 5b   | `agentcore status --json`                  | `runtime-endpoint` entries in resources array     |
| 5c   | `agentcore status --type runtime-endpoint` | Only endpoint entries shown                       |
| 5d   | Deployed agent + local-only agent          | Correct state per endpoint after deploy           |

### Flow 6: Deploy + Verify in AWS

**Goal:** Verify endpoints are created in AWS and tracked in deployed state.

| Step | Action                                | Expected                                                      |
| ---- | ------------------------------------- | ------------------------------------------------------------- |
| 6a   | `agentcore deploy`                    | Deploys without errors, CFN creates RuntimeEndpoint resources |
| 6b   | Check CloudFormation stack            | `AWS::BedrockAgentCore::RuntimeEndpoint` resources present    |
| 6c   | Check deployed-state.json             | `runtimeEndpoints` section with endpoint IDs and ARNs         |
| 6d   | `agentcore status` after deploy       | Endpoints show `[Deployed]`                                   |
| 6e   | AWS API: `get-agent-runtime-endpoint` | Endpoint exists with correct version and name                 |
| 6f   | Remove endpoint + redeploy            | Endpoint torn down in AWS                                     |

### Flow 7: Edge Cases

**Goal:** Verify correct behavior in unusual scenarios.

| Step | Scenario                                           | Expected                               |
| ---- | -------------------------------------------------- | -------------------------------------- |
| 7a   | Same endpoint name on different runtimes           | Both work (namespaced by runtime)      |
| 7b   | Multiple endpoints on one runtime                  | All display correctly in status        |
| 7c   | Remove a runtime that has endpoints                | Runtime + all its endpoints removed    |
| 7d   | Empty endpoints dict in agentcore.json             | No errors, no endpoints shown          |
| 7e   | Manually edit agentcore.json with invalid endpoint | `agentcore validate` catches the error |
| 7f   | Container build agent with endpoints               | Works same as CodeZip                  |

---

## Bug Tracking

| Alias | Bug Type | Description | Screenshots | Notes |
| ----- | -------- | ----------- | ----------- | ----- |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |
|       |          |             |             |       |

**Bug Types:** `functional` | `ux` | `validation` | `display` | `deploy` | `crash` | `regression`
