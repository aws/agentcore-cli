# Transaction Search

The AgentCore CLI automatically enables
[CloudWatch Transaction Search](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search.html)
as a post-deploy step whenever agents are deployed. This gives you full trace visibility for agent invocations without
any manual setup.

> Transaction search takes ~10 minutes to become fully active after being enabled. Traces from invocations made before
> that window may not be indexed.

## What happens by default

When you run `agentcore deploy` and the project contains at least one agent, the CLI performs the following steps after
the CloudFormation deployment succeeds:

1. **Enable Application Signals** — Calls `StartDiscovery` to create the required service-linked role (idempotent).
2. **Create CloudWatch Logs resource policy** — Adds a `TransactionSearchXRayAccess` resource policy that grants X-Ray
   permission to write to the `aws/spans` and `/aws/application-signals/data` log groups. Skipped if the policy already
   exists.
3. **Set trace segment destination** — Configures X-Ray to send trace segments to CloudWatch Logs (skipped if already
   set).
4. **Set indexing to 100%** — Updates the X-Ray `Default` indexing rule to 100% probabilistic sampling so all traces are
   indexed.

All operations are **idempotent** and safe to run on every deploy. Transaction search setup is **non-blocking** — if any
step fails (e.g., due to insufficient permissions), the deploy still succeeds and a warning is logged.

## Overriding defaults

You can customize transaction search behavior via the global CLI config file at `~/.agentcore/config.json`.

### Disable transaction search entirely

```json
{
  "disableTransactionSearch": true
}
```

When disabled, the CLI skips all transaction search setup steps during deploy.

### Change the indexing percentage

By default, 100% of traces are indexed. To lower the sampling rate:

```json
{
  "transactionSearchIndexPercentage": 50
}
```

The value must be a number between 0 and 100.

### Configuration reference

| Key                                | Type      | Default | Description                                     |
| ---------------------------------- | --------- | ------- | ----------------------------------------------- |
| `disableTransactionSearch`         | `boolean` | `false` | Skip transaction search setup on deploy         |
| `transactionSearchIndexPercentage` | `number`  | `100`   | X-Ray indexing rule sampling percentage (0–100) |

## Required IAM permissions

The following permissions are needed for the transaction search setup. If the caller lacks any of these, a warning is
logged but the deploy still succeeds.

- `application-signals:StartDiscovery`
- `logs:DescribeResourcePolicies`
- `logs:PutResourcePolicy`
- `xray:GetTraceSegmentDestination`
- `xray:UpdateTraceSegmentDestination`
- `xray:UpdateIndexingRule`

## Viewing traces

After transaction search is fully active (~10 minutes), you can view traces for your deployed agents:

```bash
# List recent traces
agentcore traces

# Get a specific trace
agentcore traces --trace-id <trace-id>
```
