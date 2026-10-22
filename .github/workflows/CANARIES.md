# Release canaries

Both scheduled orchestrators must be present on the repository's default branch.
GitHub does not run schedules from maintenance branches.

| Workflow | Test branch | Published package | Schedule | Job timeout |
| --- | --- | --- | --- | --- |
| `canary-v0.yml` | `v0.x` | Latest stable `@aws/agentcore@0` | Every 15 minutes | 30 minutes |
| `canary-v1.yml` | `v1.x` | Latest stable `@aws/agentcore@1` | Hourly at minute 15 | 90 minutes |

Each workflow calls `canary-release.yml`. It resolves an exact stable npm version
within its major, checks out the corresponding test branch, and installs that
published version globally. The v0 job runs the Strands/Bedrock smoke test; the v1
job runs tests tagged `canary` with `AGENTCORE_CLI_PATH` pointing to the installed
package. Neither job builds the CLI from source or follows npm's `latest` tag.

The separate heartbeat job runs after the test job, including when setup fails,
tests fail, or the test job is skipped. It emits `AgentCoreCLI/Canary` metric
`Success` to `us-east-1`, with dimension `Branch=v0.x` or `Branch=v1.x`. Only a
successful test job emits `1`; other outcomes emit `0`. Failure to run the
heartbeat job leaves a missing datapoint. Manual runs use the same branch and
metric as scheduled runs.

Create `v0.x` and `v1.x` with their respective test suites before enabling these
workflows. Keep both orchestrators, the reusable workflow, and `.github/scripts`
on the default branch when changing which branch is the default. Coordinate
alarm configuration with the schedule: the versioned alarms must watch these
exact dimensions, and a legacy alarm without dimensions will no longer receive
these heartbeats.

Validate workflow syntax with `actionlint`, then dispatch each orchestrator and
verify the test job, heartbeat job, and corresponding CloudWatch metric.
