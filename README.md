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

The Python templates run their agent in a box, both under `agentcore dev` and on AgentCore
Runtime. Where box comes from depends on how the agent deploys:

- A container agent's image installs box while it builds, from the GitHub release
  `v0.1.11-linux-preview.1` of the private repository `mquang-amazon/staging-boxy`: its Dockerfile
  downloads the release file, checks the SHA-256 pinned in
  `src/core/project/backends/boxRelease.ts` and unpacks it into `/opt/box`. Until the release is
  public, this needs read access to the repository and a GitHub token. `agentcore dev` builds the
  image on your machine with your GitHub login. `agentcore deploy` builds it in AWS CodeBuild,
  which reads the token from the Secrets Manager secret `agentcore/box/github-token`.
- A CodeZip agent's zip carries box. `build` and `deploy` stage it into the runtime's
  `.box-dist/` from the staging-boxy checkout that `AGENTCORE_BOX_SOURCE` names, which needs an
  Amazon Linux 2023 build in `target-al2023/release`.

### Before you start

Ask the owner of `mquang-amazon/staging-boxy` to add your GitHub account, and accept the invitation
at <https://github.com/notifications>. Then log in to the GitHub CLI and check that you can see the
release:

```sh
gh auth login
gh release view v0.1.11-linux-preview.1 --repo mquang-amazon/staging-boxy
```

### Create a GitHub token and store it (container agents, once per account and region)

1. Open <https://github.com/settings/personal-access-tokens/new> and create a fine-grained token:
   resource owner `mquang-amazon`, repository access **Only select repositories** with
   `mquang-amazon/staging-boxy`, and repository permission **Contents: Read-only**. Leave
   everything else at No access, and pick an expiration of 30 or 90 days.
2. Copy the token. Don't save it in a file, a note or a chat; keep it in a password manager if you
   need it again.
3. Store it in the account and region you deploy to. The command waits for input without showing
   it: paste the token and press Enter, so it never appears in your terminal or shell history.

   ```sh
   read -s GH_TOKEN && aws secretsmanager create-secret --region us-west-2 --name agentcore/box/github-token --secret-string "$GH_TOKEN" && unset GH_TOKEN
   ```

   When the token expires, store a new one with `put-secret-value` instead:

   ```sh
   read -s GH_TOKEN && aws secretsmanager put-secret-value --region us-west-2 --secret-id agentcore/box/github-token --secret-string "$GH_TOKEN" && unset GH_TOKEN
   ```

`create` declares the secret on the container runtime in `agentcore.json`, so the token is a
BuildKit secret of the image build, never a build arg, and never lands in the image or the build
log:

```json
"dockerBuildSecrets": { "gh_token": "agentcore/box/github-token" }
```

### Create, run and deploy

```sh
agentcore create --name MyBoxAgent --template agent-python-strands-container
cd MyBoxAgent
AGENTCORE_CONTAINER_TOOL=finch agentcore dev   # optional: uses GH_TOKEN, or else `gh auth token`
CDK_DOCKER=finch agentcore deploy --yes
agentcore invoke --runtime agent --session-id my-box-session-0000000000000000000001 --payload '{"prompt":"My favorite color is teal. Remember it."}'
agentcore invoke --runtime agent --session-id my-box-session-0000000000000000000001 --payload '{"prompt":"What is my favorite color?"}'
agentcore logs runtime --name agent --since 15m --query '"[box]"'
```

The CodeBuild log of the deploy shows
`/tmp/box.tar.gz: OK` and `box 0.1.11-linux-preview.1`. The second
answer should say teal, and the runtime log shows `running profile ...` with no `FALLBACK` or
`AccessDenied` line. For a CodeZip agent, use `--template agent-python-strands`, skip the token and
the container settings, and set `AGENTCORE_BOX_SOURCE` for `deploy`.

### Troubleshooting

- `ExpiredTokenException` from `aws`: your AWS credentials expired. Refresh them and run the command
  again.
- `ResourceNotFoundException` from `put-secret-value`: the secret doesn't exist yet. Use
  `create-secret`. `ResourceExistsException` from `create-secret` means it does: use
  `put-secret-value`.
- The deploy fails with `Secrets Manager can't find the specified secret`: the secret is in another
  account or region than the deploy target. Create it there.
- `curl: (22) The requested URL returned error: 404` in the CodeBuild log: the token can't read the
  release. Check its Contents permission on `mquang-amazon/staging-boxy`, that your invitation is
  accepted, and that the token hasn't expired.
- `agentcore dev` says to run `gh auth login`: you have no GitHub CLI login. Run `gh auth login`,
  or set `GH_TOKEN` for that command.

## Documentation

- [Command reference](command.md): every command and flag.
- [Harness project configuration](docs/harness-project-configuration.md): Harness YAML, prompts, tools, skills, and environment settings.
- [China regions](docs/china-regions.md): what is available there and how the restrictions are enforced.
- [Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/): service guides and API references.
- [Contributing](CONTRIBUTING.md): development, builds, architecture, and testing.
- [Security](SECURITY.md) · [License](LICENSE): Apache-2.0.
