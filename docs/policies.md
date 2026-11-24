# Policy engines and Cedar policies

A Policy Engine holds [Cedar](https://www.cedarpolicy.com/) policies. When you attach one to a
Gateway, the Gateway evaluates each tool call against those policies. This page covers the two
commands that create them, how the pieces are stored in `agentcore.json`, and four behaviors of
the service that are easy to miss.

## Create an engine and a policy

```bash
agentcore add policy-engine --name toolpe --attach-to-gateways toolgw
agentcore add policy --engine toolpe --name allow_websearch \
  --statement file://policies/allow-websearch.cedar
agentcore deploy
```

An engine created without `--attach-to-gateways` is not attached to any Gateway; see [Where the attachment is stored](#where-the-attachment-is-stored) and behavior 4 below.

`add policy-engine` flags:

| Flag                   | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `--name`               | Engine name: a letter first, then letters, digits or `_`, at most 48 chars. |
| `--description`        | Optional description.                                                       |
| `--encryption-key-arn` | Optional KMS key for the engine.                                            |
| `--tags`               | Optional tags: repeat `key=value`, or pass one JSON object.                 |
| `--attach-to-gateways` | Names of project Gateways to attach the engine to.                          |
| `--attach-mode`        | `enforce` (default) or `log-only`. Needs `--attach-to-gateways`.            |

`add policy` flags:

| Flag                    | Meaning                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--engine`              | The engine in this project that owns the policy.                                                                                                                                                                  |
| `--name`                | Policy name, same character rules as the engine name.                                                                                                                                                             |
| `--statement`           | The Cedar statement: inline, `file://<path>`, or `-` for stdin.                                                                                                                                                   |
| `--description`         | Optional description.                                                                                                                                                                                             |
| `--validation-mode`     | `fail-on-any-findings` (default) or `ignore-all-findings`.                                                                                                                                                        |
| `--enforcement-mode`    | `active` (default) or `log-only`.                                                                                                                                                                                 |
| `--authorization-phase` | `initiate` or `return-output`. If you omit it, the CLI picks `return-output` when the statement mentions `suppressOutput` or `context.output`, and `initiate` otherwise. This is a text match, not a Cedar parse. |

## Where the attachment is stored

The link between an engine and a Gateway is a property of the Gateway, not of the engine. In
`agentcore.json`:

```json
{
  "agentCoreGateways": [
    {
      "name": "toolgw",
      "policyEngineConfiguration": { "policyEngineName": "toolpe", "mode": "ENFORCE" }
    }
  ],
  "policyEngines": [{ "name": "toolpe", "policies": [] }]
}
```

`mode` is `ENFORCE` or `LOG_ONLY`. A `policyEngineName` that is not in `policyEngines` fails
schema validation. Policies themselves also carry an `enforcementMode` (`ACTIVE` or `LOG_ONLY`)
and a `validationMode`.

## Behaviors worth knowing

The four points below were reported on
[issue #1581](https://github.com/aws/agentcore-cli/issues/1581) by someone who measured them
against a deployed Gateway (CLI 0.30.0, `ap-northeast-1`, a Gateway with `AWS_IAM` authorization
and a web-search connector target). They describe the service rather than the CLI, and they
have not been re-checked in this repository.

1. **Cedar is default-deny.** An engine that contains only `forbid` statements blocks every tool
   call, not only the calls the `forbid` matches. The denial reads
   `No policy applies to the request (denied by default)`. Add a `permit` statement for the calls
   you want to allow; a matching `forbid` still wins over a `permit`.

   ```cedar
   permit (principal, action == AgentCore::Action::"websearch___WebSearch",
           resource == AgentCore::Gateway::"<gateway-arn>");

   forbid (principal, action == AgentCore::Action::"websearch___WebSearch",
           resource == AgentCore::Gateway::"<gateway-arn>")
   when { context.input.query like "*forbidden*" };
   ```

2. **Tool arguments are under `context.input`.** To condition on an argument, use
   `context.input.<argumentName>`, where the name is a property of the tool's input schema.
   `context.arguments.<name>` is rejected. The service checks `context` paths only after the
   action id resolves, so fix the action id before trusting any `context.*` path.

3. **`fail-on-any-findings` can reject a narrow `like` condition.** A `forbid` with a wildcard
   condition may be refused as `Overly Restrictive`, because the validator treats it as a deny
   for every request. Adding it with `--validation-mode ignore-all-findings` is the workaround
   reported for such policies.

4. **An engine that is not attached enforces nothing, and the deploy still succeeds.** If the
   `policyEngineConfiguration` block is missing from the Gateway, or is written under the engine
   instead, `agentcore deploy` completes and the policy resources exist, but no tool call is
   evaluated. After deploying, confirm the Gateway carries the engine:

   ```bash
   aws bedrock-agentcore-control get-gateway --gateway-identifier <gateway-id> \
     --query policyEngineConfiguration
   ```

   For an unattached Gateway the query should come back empty (`null` in the AWS CLI's JSON output); I have not run it myself.

Related:
[Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/).
