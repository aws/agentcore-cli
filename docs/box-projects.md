# Box projects

[Back to README](../README.md) | [Command reference](../command.md)

- [Overview](#overview)
- [Project files](#project-files)
- [The box profile](#the-box-profile)
- [The box policy](#the-box-policy)
- [Containment](#containment)
- [How each command uses box](#how-each-command-uses-box)
- [Troubleshooting](#troubleshooting)

Box projects are in preview.

## Overview

A Box project runs each of its agents in a box: a sandbox from
[Strands Box](https://github.com/strands-agents/box) that controls which files the agent can read,
write, and run, and which hosts it can connect to. The agent runs in its box under `agentcore dev`
and on Amazon Bedrock AgentCore Runtime. On AgentCore Runtime, box sends the agent's outbound calls
through its runtime's Box gateway, an AgentCore gateway that the CLI creates for the runtime.

To create a Box project, run `agentcore create` with a box template, such as
`agent-python-strands-box`. For the list of templates and how to install `box`, see
[Running agents in Box](../README.md#running-agents-in-box-preview).

`agentcore create` writes these fields in `agentcore/agentcore.json`:

```json
{
  "projectType": "box",
  "runtimes": [
    {
      "name": "agent",
      "build": "CodeZip",
      "entrypoint": "start.py",
      "codeLocation": "app/agent",
      "box": { "version": "0.3.0" },
      "platformVersion": "V2"
    }
  ],
  "agentCoreGateways": [
    {
      "name": "agent-box-egress",
      "authorizerType": "AWS_IAM",
      "protocolType": "None",
      "boundRuntime": "agent",
      "discoveryPrefix": "AGENTCORE_GATEWAY_BOX",
      "targets": []
    }
  ]
}
```

- `"projectType": "box"` makes the project a Box project.
- `"box": { "version": ... }` on a runtime names the box release that the runtime runs in. The
  `dev`, `build`, and `deploy` commands run an agent in a box only when the project has
  `"projectType": "box"` and the runtime has `box.version`. The entry point and the Dockerfile don't
  decide it.
- `"platformVersion": "V2"` is required, because box runs only on AgentCore Runtime V2.
- A CodeZip runtime's entry point is `start.py`, which starts the agent in its box. Your agent code
  stays in `main.py`.
- Each runtime gets its own Box gateway, `<runtime>-box-egress`, bound to it by `boundRuntime`.
  `agentcore build` adds the gateway's targets from the box profile. You don't add them yourself.

## Project files

```text
my-project/
  .box/
    agent/
      local/
        profile.toml           # the box profile; edit this one
        aws-metadata-block.dw  # the box policy that ships; the CLI replaces it
      aws/                     # written by build: the AgentCore Runtime profile, for you to read
  agentcore/
    agentcore.json
  app/
    agent/
      main.py
      start.py                 # CodeZip only
      Dockerfile               # container only
```

The box profile grants the agent access only to its code folder, not to `.box/<runtime>/local/`,
so the agent can't change its own profile or policy. `agentcore build` and `agentcore deploy` stage
box, the AgentCore Runtime profile, and its policy files in the runtime's `.box-dist/` folder, which
the generated `.gitignore` excludes from git.

## The box profile

`.box/<runtime>/local/profile.toml` is the profile that `agentcore dev` runs the agent with. It's
the only box profile you edit. `agentcore build` derives the AgentCore Runtime profile from it.

This is the profile that `agent-python-strands-box` creates:

```toml
packs = ["@box/base", "@box/bedrock"]
policies = ["aws-metadata-block.dw"]

[profile]
name = "MyBoxAgent-agent"

[project]
access = "write"

[options]
bedrock.region = "us-west-2"

[agent]
command = ["${{ workspace }}/.venv/bin/python", "-m", "uvicorn", "main:app", "--app-dir", "${{ workspace }}", "--reload", "--reload-dir", "${{ workspace }}", "--host", "127.0.0.1", "--port", "8081"]

[agent.env]
LOCAL_DEV = "1"
PORT = "8081"
PYTHONUTF8 = "1"
PYTHONUNBUFFERED = "1"

[agent.filesystem]
read = ["${{ workspace }}", { path = "${{ workspace }}/.venv", optional = true }, { path = "${{ home }}/.local/share/uv/python", optional = true }]
exec = [{ path = "${{ workspace }}/.venv", optional = true }, { path = "${{ home }}/.local/share/uv/python", optional = true }]
deny_write = [{ path = "${{ workspace }}/.venv", optional = true }]

[[agent.ingress]]
listen = "127.0.0.1:8080"
workload_port = 8081

[egress.bedrock]
secret.ref = "aws://"
```

| Key                  | What it does                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packs`              | The box packs that the profile imports. `@box/base` is the base pack. `@box/bedrock` routes the agent's Amazon Bedrock model calls; templates that call no Bedrock model don't import it.                                                                                              |
| `policies`           | The policy files, beside the profile, whose rules box loads. See [The box policy](#the-box-policy).                                                                                                                                                                                    |
| `[project] access`   | What the agent can do in the folder that box starts in: `"write"` for CodeZip templates, `"read"` for the container template.                                                                                                                                                          |
| `[options]`          | `bedrock.region` is the Region for Bedrock calls under `agentcore dev`. Build and deploy set it to the Region that you deploy to.                                                                                                                                                      |
| `[agent]`            | The command that starts the agent, and its environment variables.                                                                                                                                                                                                                      |
| `[agent.filesystem]` | The paths the agent can read (`read`), run programs from (`exec`), and not write (`deny_write`). A CodeZip agent gets its code folder, its virtual environment, and the uv-managed Python. The container agent also gets `/usr/local/bin`, `/usr/local/lib`, and the system libraries. |
| `[[agent.ingress]]`  | Forwards requests from the port that clients call (`listen`) to the port that the agent listens on inside the box (`workload_port`). The ports depend on the protocol.                                                                                                                 |
| `[egress.bedrock]`   | Under `agentcore dev`, signs the agent's Bedrock calls with the AWS default credential chain (`aws://`) instead of a Bedrock API key.                                                                                                                                                  |

The container template's profile differs only where the image differs: `[project] access = "read"`,
system paths in `[agent.filesystem]`, and ingress on `0.0.0.0`.

### Allow the agent to reach another host

Under the box, the agent can reach only the hosts that its profile, the packs it imports, and its
policy files allow. To allow another host, add an `[egress]` entry to
`.box/<runtime>/local/profile.toml`:

```toml
[egress.github]
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"
```

- `destinations` lists the hosts the entry can reach, as `<host>` or `<host>:<port>`. The default
  port is 443.
- `secret.ref` sets how the call is authenticated:
  - `aws://` signs the call with AWS credentials: your AWS default credential chain under
    `agentcore dev`, and the Box gateway's IAM role on AgentCore Runtime. On AgentCore Runtime, the
    gateway signs only for Amazon Bedrock, AgentCore, and AWS Lambda function URL hosts. For any
    other host, use `env://`.
  - `env://<VARIABLE>` sends an API key in a request header (by default,
    `Authorization: Bearer <key>`). Build reads the key from your environment or `.env.local` and
    declares a credential for it, and deploy stores it in AgentCore Identity.
  - With no `secret.ref`, the call is sent without a credential.

To reach a remote MCP server, add an `[mcp.<name>]` entry with `type = "http"`.

For each host that the profile or a policy allows, build adds a passthrough target named
`egress-<name>` to the runtime's Box gateway, and it adds, changes, and removes those targets as the
profile changes. Build also adds a `bedrock` target for the agent's model calls and an `agentcore`
target for its AgentCore Memory calls. The names `bedrock`, `agentcore`, and `egress-*` are reserved
on a Box gateway. Build doesn't change targets that you add with other names.

The agent also reaches the project's other gateways through its Box gateway. For each gateway in
the project that isn't bound to a runtime, build adds an `egress-gateway-<name>` target and gives
the agent `AGENTCORE_GATEWAY_<NAME>_URL`, so code that calls the gateway works in the box. A gateway
with a `CUSTOM_JWT` authorizer gets no target, and a runtime with `"containment": "PRIVATE_VPC"` gets
no targets to other gateways. If the `@aws/agentcore-cdk` library in `agentcore/cdk` can't create
these targets, build warns you and adds none.

### What build changes for AgentCore Runtime

`agentcore build` and `agentcore deploy` read the profile with `box profile show`, using the `box`
on your `PATH`. They don't change `.box/<runtime>/local/`. They derive the AgentCore Runtime profile
from it, and they write a copy to `.box/<runtime>/aws/` for you to read. The Runtime profile keeps
each key of your profile and changes only what must differ on AgentCore Runtime:

- Each `[egress]` host is routed through the runtime's Box gateway.
- The agent command, environment, file system access, and ingress get their Runtime values. For
  example, `--reload` and `LOCAL_DEV` are removed, and the Region becomes the Region that you deploy
  to.
- For CodeZip, paths in the code folder move to the unpacked code package, and the agent runs with
  the Runtime's Python.
- The `@box/agentcore` pack is added, and for CodeZip, the `@box/agentcore-codezip` pack.

Build stops, and names the file, line, and key, for a value that can't work on AgentCore Runtime.
Examples include, for CodeZip, a file system grant outside the code folder or in a home folder, a
program that's found on `PATH` (such as `npx`), and a write grant in the code folder. For both
kinds, examples include a wildcard host, a host reachable only over plain HTTP, and
`network.contain_egress = false`. The error starts with `Build stopped:` or `Deploy stopped:`.

### Credentials on AgentCore Runtime

On AgentCore Runtime, the agent needs no AWS credentials of its own. Box sends each of the agent's
AWS calls to the runtime's Box gateway and signs the request to the gateway with the runtime's
execution role. The Box gateway then calls Amazon Bedrock and AgentCore Memory with its own IAM role.
Build adds `agentcore/box-bedrock-policy.json` and `agentcore/box-memory-policy.json` to the
gateway's `additionalPolicies` so that its role can make those calls. The agent gets the deployed
memory IDs and the Runtime's Region.

### Logs and traces

On AgentCore Runtime, when the profile has no `cloudwatch_logs` target, box sends its permit, deny,
and trace records to Amazon CloudWatch Logs, in the runtime's log group
`/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` and the log stream `otel-rt-logs`. AgentCore
Runtime creates that log group, so its retention setting applies, and the log group remains after
you remove the runtime. With OpenTelemetry instrumentation on, which is the default, box also sends
the agent's spans and its own to AWS X-Ray. Standard CloudWatch and X-Ray charges apply.

- To send the records to another log group or trace target, add a `cloudwatch_logs` or
  `cloudwatch_traces` target to the profile.
- To send no spans, set `instrumentation.enableOtel` to `false` in `agentcore.json`.
- To send neither records nor spans, set `DISABLE_ADOT_OBSERVABILITY` to `"true"` in the runtime's
  `envVars` in `agentcore.json`.

## The box policy

A policy file holds rules that allow or forbid what the agent does in its box. The profile lists
its policy files under `policies`. `agentcore create` ships one policy file,
`aws-metadata-block.dw`, which keeps the agent from connecting to the AWS instance metadata service:

```text
@id("aws_metadata_addresses")
forbid (principal, action == Box::Action::"net:connect", resource)
when {
  (context.input has ip4 && context.input.ip4 == "169.254.169.254") ||
  (context.input has ip6 && context.input.ip6 == "fd00:ec2::254")
};

@id("aws_metadata_hosts")
forbid (principal, action == Box::Action::"net:connect", resource)
when {
  context.input.host == "169.254.169.254" ||
  context.input.host == "instance-data" ||
  context.input.host == "instance-data.ec2.internal"
};
```

The metadata service serves the credentials of the role that the agent runs with. Because the
agent's AWS calls are signed outside the box, the agent doesn't need those credentials, and the
policy keeps the agent from reading them. The policy doesn't block other link-local addresses or the
metadata services of other clouds.

`agentcore create` and `agentcore add runtime` replace `aws-metadata-block.dw` each time they write
the profile, so don't edit it. To add rules of your own, put them in another file beside the
profile, such as `policy.dw`, and add that file to `policies`:

```toml
policies = ["aws-metadata-block.dw", "policy.dw"]
```

Build copies each policy file unchanged beside the AgentCore Runtime profile. A host that a permit
rule allows also gets a gateway target. When box enforces a rule that the gateway can't, such as a
rule on a path or method, build warns you. Build errors name a rule by its `@id`.

Policy rules are written in Dogwood, the policy language of Strands Box. For the rule syntax, see
[Policies](https://github.com/strands-agents/box/blob/main/docs/cli/policies.md) in the Strands Box
documentation.

## Containment

`agentcore create --containment` sets how contained a Box project's runtime is.
`--containment private-vpc` needs a box template.

| `--containment`       | In `agentcore.json`                                                     | What it does                                                                                                 |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sandboxed` (default) | No field, or `"containment": "SANDBOXED"`                               | Runs the agent in a box. On AgentCore Runtime, box sends the agent's outbound calls through its Box gateway. |
| `private-vpc`         | `"containment": "PRIVATE_VPC"` and `"network": { "mode": "CONTAINED" }` | Also runs the runtime in its own private VPC with no internet path.                                          |

`sandboxed` contains the agent's process: box decides which files and hosts the agent can reach.
`private-vpc` adds a network-level control beneath box: the runtime runs in a VPC that has no
internet path, so the runtime's network access doesn't depend on box's rules alone.

### Private VPC

```sh
agentcore create --name MyContainedAgent --template agent-python-strands-box-container --containment private-vpc
```

- A project can have only one runtime with `"containment": "PRIVATE_VPC"`. Create a project for each
  contained runtime.
- Don't set `networkMode` or `networkConfig` on a `PRIVATE_VPC` runtime. The `network` field is
  allowed only with `PRIVATE_VPC`.
- A `PRIVATE_VPC` runtime doesn't get targets to the project's other gateways.
- **Cost.** The private VPC adds charges for as long as it's deployed. As an approximate estimate,
  it costs about $58 per month for a CodeZip runtime and about $88 per month for a container
  runtime, and more with three Availability Zones. Actual costs vary by AWS Region and usage. For
  current prices, see [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/).
- **The VPC is kept after you delete the stack.** It counts toward your account's Amazon VPC quota
  until you delete it.

You can set these optional fields in the runtime's `network`:

| Field                 | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `cidr`                | An aligned IPv4 CIDR block with a /16 to /24 prefix, such as `10.0.0.0/16` |
| `availabilityZoneIds` | Two or three unique Availability Zone IDs, such as `usw2-az1`              |
| `ipAddressType`       | `IPV4` or `DUAL_STACK`                                                     |

To change anything else about the VPC, customize the CDK app. See
[Extending the CDK app](../README.md#extending-the-cdk-app).

If the `@aws/agentcore-cdk` library in `agentcore/cdk` is older than containment, deploy stops
instead of deploying the runtime without its private VPC. Update the library, then deploy again.

## How each command uses box

Each version of the CLI supports one box release. `agentcore build` and `agentcore deploy` set each
runtime's `box.version` to that release, and tell you when they change it.

- **CodeZip, build and deploy:** the CLI downloads box from the
  [Strands Box releases](https://github.com/strands-agents/box/releases) once into
  `~/.agentcore/box/`, checks its SHA-256 checksum, and includes it in the code package.
- **Container, build and deploy:** the image downloads box while it builds and checks its
  checksum. `agentcore deploy` builds the image in AWS CodeBuild, which needs network access to
  github.com.
- **CodeZip, dev:** the agent runs in the `box` on your `PATH`. `agentcore create` and
  `agentcore dev` stop and tell you how to install box when it isn't on your `PATH`.
- **Container, dev:** `agentcore dev` builds the image on your machine, which needs network access
  to github.com. You don't need `box` installed locally.

Build and deploy also run `box profile show` with the `box` on your `PATH`, so install box before
you build a project of either kind.

## Troubleshooting

- **`box` isn't found, or box refuses the profile under `agentcore dev`.** Check that `which box`
  prints `~/.local/bin/box` and that `box --version` prints the version from
  [Set up a Box project](../README.md#set-up-a-box-project). An older box can't read the profiles
  that this CLI writes. Run the installer again with that `BOX_VERSION`.
- **`ExpiredTokenException` from `deploy`.** Your AWS credentials have expired. Refresh them and run
  the command again.
- **`curl: (22) The requested URL returned error: 404` in the CodeBuild log.** The box release that
  the CLI names isn't published.
- **A SHA-256 checksum mismatch.** The release file changed after this CLI version was published.
  Nothing was installed.
- **`box run` exits with an error in the runtime log.** Box refused its profile, and the agent
  doesn't start. The error names the reason. On AgentCore Runtime, the agent never runs outside its
  box.
