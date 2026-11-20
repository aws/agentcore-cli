# AgentCore CLI

`agentcore` is a command-line tool and interactive terminal UI (TUI) for
**[Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)**, the platform for building
and running production AI agents ([documentation](https://docs.aws.amazon.com/bedrock-agentcore/)).

It gives you two ways to work, from the same package:

- **A scriptable CLI** — flag-driven commands with JSON output (`--json`) for coding agents,
  scripts, and CI.
- **An interactive TUI** — guided flows for creating projects, browsing resources, and chatting
  with agents.

```bash
agentcore               # launch the interactive TUI
agentcore status --json # scriptable, machine-readable output
```

Using the AgentCore APIs directly means calling several services, setting up execution roles, and
handling streamed responses. `agentcore` takes care of those details so you can create, deploy, and
invoke agents from your terminal.

## Installation

You need Node.js 20.12 or later and AWS credentials configured as for the AWS CLI. Python templates
also need [`uv`](https://docs.astral.sh/uv/getting-started/installation/).

```bash
npm install -g @aws/agentcore
```

If the Python-based Bedrock AgentCore Starter Toolkit is installed, uninstall it: both provide an
`agentcore` command.

## Quick Start

A project holds either kind of agent, or both:

- A **Harness** is a managed agent you configure in YAML — model, system prompt, tools, skills — and
  AgentCore runs for you.
- A **Runtime** is agent code you own, scaffolded from a template and deployed for you.

Create a project, add a Harness to it, deploy it, and send a prompt:

```bash
agentcore create --name MyProject
cd MyProject
agentcore add harness --name MyAssistant
agentcore deploy
agentcore invoke --harness MyAssistant --prompt "Hey, what can you do for me?"
```

To invoke a CUSTOM_JWT Harness, supply AWS credentials for the Harness lookup and pipe a
bearer token for the invocation:

```bash
printf '%s' "$JWT" | agentcore invoke \
  --harness MyAssistant-AbCdEf1234 \
  --region us-east-1 --bearer-token - --prompt "Hello"
```

The same flags work with `agentcore harness invoke --id <harness-id>`. You can also select a
Harness by ARN with `agentcore invoke --harness <harness-arn>`, but the CLI still looks up
its configuration before invoking it. `--bearer-token file://<path>` reads a token from a file.

To start from code you own instead, pick a template (`agentcore create --help` lists them):

```bash
agentcore create --name MyAgent --template agent-python-strands
```

`agentcore create --template` scaffolds the template with its default model provider (Amazon
Bedrock for the model-backed templates). To use another provider, run `agentcore create` with no
flags: for templates that take a model provider (`agent-python-strands` and its `-container`
variant, `a2a-python-strands`, `agui-python-strands`, `agent-typescript-strands`) the wizard asks
for the provider (Amazon Bedrock, Anthropic, OpenAI, an OpenAI-compatible endpoint, Gemini, or
LiteLLM, which is Python-only), the model id, and an API-key file. The API key is kept in
`agentcore/.env.local` and provisioned as an AgentCore Identity credential on deploy.

To bring your own code into a project instead, add a runtime for it:

```bash
agentcore add runtime --name search --language python   # or --language typescript
```

`add runtime` doesn't generate code. It creates `app/search/` with a `README.md` and an
`AGENTS.md` describing what the code has to provide for the chosen `--protocol` (`HTTP` by
default, or `MCP`, `A2A`, `AGUI`), and registers the runtime in `agentcore.json` with starting
values (a CodeZip build on the latest Python or Node.js, entrypoint `main.py` or `main.js`). If
`app/search/` already exists, your files are left alone and only the missing docs are added.

`agentcore dev`, `agentcore build`, and `agentcore deploy` then update `agentcore.json` from the
code and print what changed. Adding a `Dockerfile` to the folder switches the runtime to a
container build. `requires-python` in `pyproject.toml` or `engines.node` in `package.json`
constrains the runtime version: it changes only when the range excludes the current one, and then
to the highest version the range allows. The Python entrypoint comes from `[tool.agentcore]
entrypoint` in `pyproject.toml`; TypeScript is always bundled from `main.ts` (a `package.json`
`"main"` of `main.ts` or `main.js` agrees with that, and any other value is ignored with a
warning). Where the code doesn't say, the value in `agentcore.json` is kept.

Run `agentcore create` outside any existing project.

## Projects

`create` makes a directory holding `agentcore/agentcore.json`, the spec that declares the project's
resources, and `agentcore/cdk/`, the AWS CDK app that deploys them. Deployment targets — an account
and region each — live in `agentcore/aws-targets.json`. Project commands find the project by walking
up from the current directory.

`agentcore dev` runs runtimes locally or deploys harnesses and prints invoke guidance.
Use `--mode browser` for Agent Inspector, `--skip-deploy` to reuse deployed harnesses,
and `--agent <name>` to choose an agent in mixed projects.

New payment credentials receive provider names that payment connectors can reference.
An existing payment credential keeps the provider ARN recorded for its deployment
target. If that ARN is incompatible with a manual connector, deploy stops before
provisioning anything. Add a payment credential under a different name and point
the connector to it; the old provider remains until you remove its credential
from the project and deploy each affected target.

## Commands

| Command                                                          | Purpose                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `create`, `add`, `remove`, `export`, `migrate`                   | Create a project, add or remove its resources, export a resource to code, migrate a v0 project |
| `dev`, `build`, `deploy`, `status`                               | Run locally, build, deploy, and check what is deployed                                         |
| `invoke`, `logs`, `traces`                                       | Talk to deployed agents and inspect their logs and traces                                      |
| `runtime`, `harness`, `gateway`, `memory`, `identity`, `payment` | Inspect and manage deployed resources, with or without a project                               |
| `eval`                                                           | Evaluate agents, manage datasets and configurations, and run experiments                       |
| `feedback`, `config`, `update`                                   | Send feedback, read and write CLI settings, update the CLI                                     |

In a terminal, a command run without flags opens its interactive flow; pass flags and it runs
non-interactively. `--help` on any command lists its subcommands and flags, and the
[command reference](command.md) has them all.

Global flags, available on every command:

| Flag       | Purpose                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `--region` | AWS region. Resolved from this flag, then `AWS_REGION`, `AWS_DEFAULT_REGION`, the active profile, then `us-east-1`. |
| `--json`   | Emit JSON instead of opening the TUI.                                                                               |
| `--debug`  | Debug logging.                                                                                                      |

## Extending the CDK app

`agentcore/cdk/` has two source files. `bin/cdk.ts` reads the project once
(`readAgentCoreProject`), makes one stack per deployment target
(`resolveTargetStacks`) and turns `agentcore.json` into the application's props
(`transformAgentCoreJson`). All three come from `@aws/agentcore-cdk`, so that
logic is updated through the library rather than changes to your CDK app.

`lib/cdk-stack.ts` instantiates one `AgentCoreApplication`. This is the file you
edit to add your own resources. Runtimes and harnesses implement `iam.IGrantable`,
so you can pass them to a resource's CDK grant methods to give your agents access.
Use `addEnvironmentVariable` to pass resource names, ARNs, or endpoints to your agent.

This example gives the generated runtime named `agent` access to a table:

```ts
import { AgentCoreApplication, type AgentCoreApplicationProps } from "@aws/agentcore-cdk";
import { Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface AgentCoreStackProps extends StackProps {
  application: AgentCoreApplicationProps;
}

export class AgentCoreStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);
    this.application = new AgentCoreApplication(this, "Application", props.application);

    const orders = new dynamodb.Table(this, "Orders", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    const agent = this.application.runtime("agent");
    orders.grantReadWriteData(agent);
    agent.addEnvironmentVariable("ORDERS_TABLE", orders.tableName);
  }
}
```

For a Harness, use `this.application.harness("<name>")` instead.

Run `agentcore deploy` to apply your changes. The names passed to
`runtime()` or `harness()` must match the names in your project.

If you use an existing execution role through `executionRoleArn`, CDK cannot
change its permissions. You'll need to add the required permissions to that role
yourself.

Note that `agentcore status` reports only the resources `agentcore.json`
declares, not the ones you add in the stack.

## Running agents in Box (preview)

Seven templates run their agent in a box, both under `agentcore dev` and on AgentCore Runtime:
the CodeZip templates `agent-python-strands-box`, `agent-python-minimal-box`,
`agent-python-langchain-box`, `a2a-python-strands-box`, `agui-python-strands-box`, and
`mcp-python-fastmcp-box`, and the container template `agent-python-strands-box-container`.
`agentcore create --template <name>` makes a Box project from one of them; every other template
runs its agent without box. Each runtime of a Box project runs in a box, with its own box profile,
`.box/<runtime>/local/profile.toml`. `agentcore add runtime` adds a Python CodeZip runtime in a box
to a Box project, and refuses a TypeScript runtime and a Bedrock Agent import there.
`agentcore export harness` refuses a Box project. Each box runtime needs its
`"box": { "version": ... }` in `agentcore.json`, which create and add runtime write, and its local
box profile; build and deploy stop without them. Build derives the AgentCore Runtime profile of
each runtime from its local profile. box comes from the public GitHub release `v0.1.11-mquang.preview.9` of
[mquang-amazon/box-releases](https://github.com/mquang-amazon/box-releases). No token or account
is needed to download it. That release has only the Linux arm64 build that ships to AgentCore
Runtime. For `agentcore dev` and the profile checks of `build` on macOS, install the macOS build of
`v0.1.11-linux-preview.7`, or of a later release that has one.

`src/core/project/backends/boxRelease.json` pins the Linux build of box that ships to AgentCore
Runtime, with its repository, version and SHA-256. `bun scripts/bump-box-release.ts --box <version>`
(with `--box-repo` to move repository) rewrites the file from the release's `SHA256SUMS.txt`.

How each command uses it:

- A CodeZip agent's zip carries box. `build` and `deploy` download box once with `curl` into
  `~/.agentcore/box/`, check it against its pinned SHA-256, and stage box and its packs into the
  runtime's `.box-dist/`.
- A container agent's image downloads box while it builds. `dev`, `build` and `deploy` stage the
  release that `box.version` names, with its checksum, as `box-release.env` beside the Dockerfile
  (`.box-dist/`, or `.box-dev/` under `dev`), and the Dockerfile downloads that release with `curl`,
  checks its SHA-256 and unpacks it into `/opt/box`. The CLI downloads nothing for a container, so
  the build machine, or AWS CodeBuild on `deploy`, needs network to github.com. `agentcore dev`
  builds the image on your machine and `agentcore deploy` builds it in AWS CodeBuild.
- A CodeZip agent under `agentcore dev` runs in the `box` on your PATH, which you install from
  the release: download the build for your machine, unpack it into a folder, and add that folder
  to your PATH. `agentcore create --template agent-python-strands-box` and `agentcore dev` stop
  with that instruction when `box` is not on your PATH. Container agents need no local box.

Each box runtime names its release in `agentcore.json` with `"box": { "version": "<version>" }`,
which `agentcore create` writes. The pinned version keeps the checksums in `boxRelease.json`;
another version takes them from its release's `SHA256SUMS.txt`. To try an unreleased box build,
publish it as a pre-release with the same file names and set `box.version` to it.

On AgentCore Runtime, box signs the agent's Bedrock and Memory calls with the execution role: the
profile's bare `aws://` resolves the AWS default credential chain, which box reads and refreshes
itself.

### Create, run and deploy

```sh
agentcore create --name MyBoxAgent --template agent-python-strands-box-container
cd MyBoxAgent
AGENTCORE_CONTAINER_TOOL=finch agentcore dev   # optional
agentcore deploy --yes
agentcore invoke --runtime agent --session-id my-box-session-0000000000000000000001 --payload '{"prompt":"My favorite color is teal. Remember it."}'
agentcore invoke --runtime agent --session-id my-box-session-0000000000000000000001 --payload '{"prompt":"What is my favorite color?"}'
agentcore logs runtime --name agent --since 15m --query '"running profile"'
```

The CodeBuild log of the deploy shows `/tmp/box.tar.gz: OK` and `box 0.1.11-mquang.preview.9`. The
second answer should say teal, and the runtime log shows `running profile ...` with no `ERROR`,
`blocked by egress control` or `AccessDenied` line. For a CodeZip agent, use
`--template agent-python-strands-box` and skip the container settings.

A boxed agent gets the deployed Memory IDs and the Runtime's region inside the box. It does not get
the `AGENTCORE_GATEWAY_<NAME>_URL` variables of gateways you add yourself: its calls go out through
its Box gateway.

A Box project that an older CLI created still has `start.sh`, or a Dockerfile that runs it. Build
and deploy now render profiles that those files cannot start. Create the project again, or copy
`start.py` (CodeZip) or the `Dockerfile` (container) from a new `agentcore create` project.

### Troubleshooting

- `ExpiredTokenException` from `aws` or `deploy`: your AWS credentials expired. Refresh them and
  run the command again.
- `curl: (22) The requested URL returned error: 404` in the CodeBuild log, or a deploy error that
  names the release URL: the pinned version is not published in `mquang-amazon/box-releases`.
- `SHA-256 ... not the pinned` or `sha256sum: WARNING: 1 computed checksum did NOT match`: the
  release asset changed after it was pinned. Nothing was installed.
- `box run` exits with an error in the runtime log: box refused its profile, and the agent does
  not start. The error names the reason. The agent never runs outside box on AgentCore Runtime.
- A CodeZip agent on `PYTHON_3_10` needs `tomli` in its dependencies, because `start.py` reads the
  profile with it there. `agent-python-strands-box` lists it.

## Documentation

- [Command reference](command.md): every command and flag.
- [Harness project configuration](docs/harness-project-configuration.md): Harness YAML, prompts, tools, skills, and environment settings.
- [China regions](docs/china-regions.md): what is available there and how the restrictions are enforced.
- [Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/): service guides and API references.
- [Contributing](CONTRIBUTING.md): development, builds, architecture, and testing.
- [Security](SECURITY.md) · [License](LICENSE): Apache-2.0.
