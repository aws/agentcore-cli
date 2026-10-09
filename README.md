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

To start from code you own instead, pick a template (`agentcore create --help` lists them):

```bash
agentcore create --name MyAgent --template agent-python-strands
```

`agentcore create --template` scaffolds the template with its default model provider (Amazon
Bedrock for the model-backed templates). To use another provider, add the runtime with
`agentcore add runtime --template <template>` instead: templates that take a model provider
(`agent-python-strands` and its `-container` variant, `a2a-python-strands`, `agui-python-strands`,
`agent-typescript-strands`) accept `--model-provider` (`bedrock`, `anthropic`, `open_ai`,
`openai_compatible`, `gemini`, `lite_llm`; `openai` and `litellm` are accepted too; LiteLLM is
Python-only), `--model-id`, and `--api-key file://<path>` there; the API key is kept in
`agentcore/.env.local` and provisioned as an AgentCore Identity credential on deploy.
`openai_compatible` is the OpenAI client pointed at any OpenAI-compatible endpoint (DeepSeek, Qwen,
a self-hosted vLLM, …): it requires `--api-base <url>` and `--model-id <model>`, since nothing is
known about the endpoint until you name it, while `open_ai` always calls api.openai.com and takes
neither. A self-hosted endpoint that ignores authentication still needs an `--api-key` file; any
placeholder value works.

Run `agentcore create` with no flags for a guided setup; for those templates the wizard asks the
same provider, model id, and API-key-file questions. Either way, run it outside any existing
project.

## Projects

`create` makes a directory holding `agentcore/agentcore.json`, the spec that declares the project's
resources, and `agentcore/cdk/`, the AWS CDK app that deploys them. Deployment targets — an account
and region each — live in `agentcore/aws-targets.json`. Project commands find the project by walking
up from the current directory.

`agentcore dev` runs runtimes locally or deploys harnesses and prints invoke guidance.
Use `--mode browser` for Agent Inspector, `--skip-deploy` to reuse deployed harnesses,
and `--agent <name>` to choose an agent in mixed projects.

## Commands

| Command                                                          | Purpose                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `create`, `add`, `remove`, `export`                              | Create a project, add or remove its resources, export a resource to code |
| `dev`, `build`, `deploy`, `status`                               | Run locally, build, deploy, and check what is deployed                   |
| `invoke`, `log`, `traces`                                        | Talk to deployed agents and inspect their logs and traces                |
| `runtime`, `harness`, `gateway`, `memory`, `identity`, `payment` | Inspect and manage deployed resources, with or without a project         |
| `eval`                                                           | Evaluate agents, manage datasets and configurations, and run experiments |
| `feedback`, `config`, `update`                                   | Send feedback, read and write CLI settings, update the CLI               |

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

## Documentation

- [Command reference](command.md): every command and flag.
- [Harness project configuration](docs/harness-project-configuration.md): Harness YAML, prompts, tools, skills, and environment settings.
- [China regions](docs/china-regions.md): what is available there and how the restrictions are enforced.
- [Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/): service guides and API references.
- [Contributing](CONTRIBUTING.md): development, builds, architecture, and testing.
- [Security](SECURITY.md) · [License](LICENSE): Apache-2.0.
