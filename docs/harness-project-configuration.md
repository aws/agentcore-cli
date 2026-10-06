# Harness Project Configuration

[Back to README](../README.md) | [Command reference](../command.md)

- [Harness project files](#harness-project-files)
- [Model](#model)
- [System prompt](#system-prompt)
- [Memory](#memory)
- [Tools and tool access](#tools-and-tool-access)
- [Skills](#skills)
- [Conversation context and invocation limits](#conversation-context-and-invocation-limits)
- [Environment and containers](#environment-and-containers)
- [Networking and authentication](#networking-and-authentication)
- [Session lifetime and storage](#session-lifetime-and-storage)
- [Tags](#tags)
- [Validation](#validation)

## Harness Project Files

`agentcore create` (without `--template`) and `agentcore add harness` share the same
scaffolding flow. Each harness has `app/<name>/harness.yaml` and
`app/<name>/system-prompt.md`:

```text
my-project/
  agentcore/
    agentcore.json
  app/
    assistant/
      harness.yaml
      system-prompt.md
```

`agentcore/agentcore.json` registers the harness and its directory.
`harness.yaml` configures the agent running there. Keep its `name` aligned with
the registry entry. The name starts with a letter and contains letters, numbers,
or underscores. Deployed names also include the project and target names, so
the combined name must fit the service's 40-character Harness name limit.

The generated YAML keeps a few active settings and comments showing options you
can add. Commented values such as `maxIterations: 15` are examples, not defaults.
The following is a small valid configuration:

```yaml
name: assistant
model:
  bedrockModelConfig:
    modelId: global.anthropic.claude-sonnet-5-5
memory:
  managedMemoryConfiguration: {}
```

Edit the file, then run `agentcore deploy` from the project directory to
apply changes. A local edit does not update an already deployed harness.
The examples below are separate alternatives or sections to add to your file.
Replace a section when switching modes rather than keeping fields from both.
Replace example ARNs, URLs, and resource IDs with your own.

The generated file follows the Harness API's nesting. CLI flags and construct
inputs are unchanged. The old flat YAML shape is not supported.

## Model

Select one configuration under `model`: `bedrockModelConfig`, `openAiModelConfig`,
`geminiModelConfig`, or `liteLlmModelConfig`. Each requires `modelId`. Choose a
model supported by the selected provider and API format.

| Provider   | Credentials                        | Provider-specific options                                          |
| ---------- | ---------------------------------- | ------------------------------------------------------------------ |
| `bedrock`  | Harness execution role             | `apiFormat`: `converse_stream`, `responses`, or `chat_completions` |
| `open_ai`  | `apiKeyArn` is required            | `apiFormat`: `responses` or `chat_completions`                     |
| `gemini`   | `apiKeyArn` is required            | `topK`: integer from 0 to 500                                      |
| `lite_llm` | Depends on the underlying provider | `apiBase` for a custom endpoint                                    |

`apiKeyArn` identifies an AgentCore Identity API-key credential provider, not a
raw API key or a Secrets Manager secret ARN. The execution role needs permission
to retrieve that credential. Only use an `apiBase` endpoint you trust with the
provider credential.

Provider configurations support `temperature` (0-2), `topP` (0-1), and a positive
integer `maxTokens`, but individual models can reject optional fields entirely.
For example, Claude Sonnet 5 and 5.5 reject `temperature`; leave it unset for those models.
Check the selected model's parameter support before enabling tuning fields.
`maxTokens` inside the selected model configuration limits output for each model call. The top-level `maxTokens`
field applies across the invocation, which can make several model calls.

For Bedrock:

```yaml
model:
  bedrockModelConfig:
    modelId: global.anthropic.claude-sonnet-5-5
    apiFormat: converse_stream
    maxTokens: 4096
```

For a direct OpenAI model:

```yaml
model:
  openAiModelConfig:
    modelId: gpt-6.1-sol
    apiFormat: responses
    apiKeyArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/openai
```

For Gemini:

```yaml
model:
  geminiModelConfig:
    modelId: gemini-3.8-flash
    apiKeyArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/gemini
    topK: 40
```

For LiteLLM, use a provider-prefixed model ID:

```yaml
model:
  liteLlmModelConfig:
    modelId: openai/gpt-6.1-sol
    apiBase: https://models.example.com/v1
    apiKeyArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/model-proxy
```

Do not set `apiFormat` for `gemini` or `lite_llm`, `topK` for other providers,
or `apiBase` outside `lite_llm` in this YAML format.
LiteLLM also accepts `model.liteLlmModelConfig.additionalParams` for provider-specific options.

See [Models and instructions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html)
for provider behavior and supported API formats.

## System Prompt

Put the agent's instructions in `system-prompt.md`, next to `harness.yaml`.
Both deployment and local export use inline `systemPrompt` text when it is
provided. Otherwise, instructions come from `system-prompt.md` next to
`harness.yaml`. Prompt contents are not trimmed, and blank prompts are rejected.

Use one text block for inline instructions:

```yaml
systemPrompt:
  - text: |
      You are a concise assistant.
      Ask for clarification when a request is ambiguous.
```

`systemPrompt[0].text` is literal text, not a local filename. Do not set it to
`./instructions.md` or `file://instructions.md` expecting the file to be read.
Path-shaped inline values ending in `.md` or `.txt` are rejected by the current
schema. Use the conventional `system-prompt.md` file instead.

`agentcore add harness --system-prompt "Your instructions"` writes the supplied
text to `system-prompt.md`, leaving `systemPrompt` out of the generated YAML.

## Memory

Memory persists conversation events and can extract information for later
retrieval. It is separate from the conversation truncation settings that control
what fits in a model request.

Newly scaffolded harnesses use `memory: { managedMemoryConfiguration: {} }` unless another memory
configuration was supplied. Removing `memory` from an existing YAML file disables
memory. Reading the file never adds the scaffold default.

### Managed Memory

The Harness service creates and owns the memory:

```yaml
memory:
  managedMemoryConfiguration:
    strategies:
      - SEMANTIC
      - SUMMARIZATION
      - USER_PREFERENCE
      - EPISODIC
    eventExpiryDuration: 30
```

`strategies` is optional. When supplied, it must contain one to four entries,
not an empty list. `eventExpiryDuration` is event retention in days, from 3 to 365. Omit these fields to use service defaults. `encryptionKeyArn` can specify
a KMS key.

### Existing Memory

Use `name` for a memory declared in this project's `agentcore.json`:

```yaml
memory:
  agentCoreMemoryConfiguration:
    name: ConversationMemory
    messagesCount: 20
    retrievalConfig:
      topK: 5
      relevanceScore: 0.5
```

`messagesCount` controls how many recent memory messages are loaded. For a
project memory referenced by name, `retrievalConfig` applies the same retrieval
settings to its strategy namespaces. Set at least one of `topK` (a positive
integer) or `relevanceScore` (0-1).

Use `arn` for a memory outside the project:

```yaml
memory:
  agentCoreMemoryConfiguration:
    arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/ConversationMemory-abc123
    actorId: support-user
    messagesCount: 20
```

An explicit `actorId` scopes memory to that actor. Do not use a single fixed actor
for unrelated users who should have separate memory. `retrievalConfig` is not
supported with an ARN reference in this YAML format because the project cannot
resolve that memory's strategy namespaces. Managed-memory settings such as
`strategies` and `eventExpiryDuration` do not belong under `agentCoreMemoryConfiguration`.

### Disabled Memory

```yaml
memory:
  disabled: {}
```

Omitting `memory` from the file has the same effect. Enabled memory incurs
AgentCore Memory charges. See
[Harness memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.html)
for service behavior.

## Tools and Tool Access

`tools` adds capabilities alongside the Harness's built-in shell and file
operations. Omitting it, or setting `tools: []`, adds no extra tools.
Give each entry a unique `name`.

The `type` uses an underscore-separated identifier, while its `config` key uses
camel case. They must match:

| `type`                       | `config` key               | Configuration                                          |
| ---------------------------- | -------------------------- | ------------------------------------------------------ |
| `remote_mcp`                 | `remoteMcp`                | Endpoint `url`, with optional `headers`                |
| `agentcore_gateway`          | `agentCoreGateway`         | `gatewayArn`, with optional `outboundAuth`             |
| `agentcore_browser`          | `agentCoreBrowser`         | Optional `browserArn`                                  |
| `agentcore_code_interpreter` | `agentCoreCodeInterpreter` | Optional `codeInterpreterArn`                          |
| `inline_function`            | `inlineFunction`           | `description` and `inputSchema` for a client-side tool |

Browser and Code Interpreter use service-provided resources when their
configuration is omitted:

```yaml
tools:
  - name: browser
    type: agentcore_browser
  - name: code_interpreter
    type: agentcore_code_interpreter
  - name: research
    type: remote_mcp
    config:
      remoteMcp:
        url: https://mcp.example.com/mcp
  - name: company_tools
    type: agentcore_gateway
    config:
      agentCoreGateway:
        gatewayArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/company-tools-abc123
        outboundAuth:
          awsIam: {}
```

Remote MCP `headers` is a string-to-string map. Header values are configuration,
not a secret store. The service supports API-key provider references such as
`${arn:aws:bedrock-agentcore:...}` instead of a raw key.

Gateway `outboundAuth` chooses how the Harness calls the Gateway. Use exactly
one of `awsIam`, `none`, or `oauth`. For OAuth:

```yaml
tools:
  - name: company_tools
    type: agentcore_gateway
    config:
      agentCoreGateway:
        gatewayArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/company-tools-abc123
        outboundAuth:
          oauth:
            providerArn: arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/company
            scopes: [tools.read]
            grantType: CLIENT_CREDENTIALS
```

OAuth also accepts `USER_FEDERATION` and a string map of `customParameters`.
These settings do not replace the Gateway's caller authorization or the
execution role's required permissions.

An inline function declares a tool that your caller implements. It does not
upload a function to the Harness environment:

```yaml
tools:
  - name: approve_purchase
    type: inline_function
    config:
      inlineFunction:
        description: Request approval for a purchase.
        inputSchema:
          type: object
          properties:
            amount:
              type: number
          required: [amount]
```

Use an SDK caller that handles the tool call and returns its result in the same
session. The CLI's prompt-based invoke commands do not implement that handoff
for your application.

### Allowed Tools

`allowedTools` filters the tools the model can select. The generated file uses
`["*"]`, which allows all available tools. For a narrower selection:

```yaml
allowedTools:
  - "@builtin"
  - "@research/search"
```

`@builtin` allows the built-in tools. `@research/search` allows the `search`
tool from the tool entry named `research`. `@research` allows all tools from
that entry, and patterns such as `@research/read_*` select matching tools.

This is not an IAM policy and does not grant access to AWS resources. It also
does not restrict direct command execution through `harness exec`.
Do not use an empty list as a deny-all policy: the current CDK mapper omits an
empty list when creating the Harness.

See [Harness tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)
for tool behavior and allowlist patterns.

## Skills

A skill is a directory containing instructions and, optionally, scripts and
supporting files. Tools give an agent capabilities. Skills explain when and how
to use them for a particular task.

Each skill has a `SKILL.md` file with a name and description in YAML frontmatter:

```markdown
---
name: refund-policy
description: Use when answering questions about refund eligibility.
---

# Refund Policy

Read references/policy.md before answering.
Ask for the purchase date if it is missing.
```

The directory can also contain `scripts/`, `references/`, and `assets/`.
The example above also needs `references/policy.md` in the skill directory.
The Harness exposes skill metadata to the model and loads full instructions
when needed. Adding a skill does not run every script it contains or grant
additional AWS permissions.

`skills` is a list of sources. You can mix source types, but each entry describes
one source. `skills: []` means no configured skill sources. Only use sources
whose instructions and scripts you trust.

### Git Skills

Use an HTTPS repository URL. `path` selects a directory inside that repository
containing `SKILL.md`. Omit `path` if the skill is at the repository root:

```yaml
skills:
  - git:
      url: https://github.com/anthropics/skills.git
      path: skills/docx
```

For a private repository, store its access token in an AgentCore Identity API-key
credential provider. The project deployment path resolves `auth.credentialName`
from the [project credentials](../command.md#agentcore-add-credentials) declared in
`agentcore.json`:

```yaml
skills:
  - git:
      url: https://github.com/example/private-skills.git
      path: skills/support
      auth:
        credentialName: github-token
        username: oauth2
```

`credentialName` is the project's logical credential name, not the token value.
`username` is optional and defaults to `oauth2` in the service. Deploy provisions
the project credential and supplies its ARN to the Harness.

Use `credentialName` for project deployments. Although the CLI authoring schema
also accepts `auth.credentialArn`, the current CDK skill loader requires a project
credential name and does not resolve that alternative.

### S3 Skills

Use `s3.uri` to point to a skill directory in S3:

```yaml
skills:
  - s3:
      uri: s3://your-skills-bucket/skills/company-style/
```

That prefix should contain `SKILL.md` and any supporting files. The Harness
execution role needs `s3:GetObject` and `s3:ListBucket` access. An encrypted
source may also require access to its KMS key.

### Filesystem Skills

A standalone `path` refers to a directory **inside the running Harness
environment**, not a directory on your development machine:

```yaml
skills:
  - path: /opt/skills/refund-policy
```

Include that directory in your custom container image, or prepare it in the
session before invoking the agent. For example, this Dockerfile instruction
copies a local skill into the image:

```dockerfile
COPY skills/refund-policy /opt/skills/refund-policy
```

The local `skills/refund-policy` directory must be in the Docker build context.
Adding `path` to `harness.yaml` alone does not upload it.

This is different from `git.url` plus `git.path`, where `path` is relative to the
Git repository. Use explicit `path`, `s3`, or `git` source objects.

### Bundled AWS Skills

`awsSkills` selects skills bundled with the managed Harness. `paths` accepts
relative paths or glob patterns from the
[AWS skills catalog](https://github.com/aws/agent-toolkit-for-aws/tree/main/skills):

```yaml
skills:
  - awsSkills:
      paths:
        - core-skills/aws-cdk
        - specialized-skills/operations-skills/*
```

Use `awsSkills: {}` to select all bundled AWS skills. Patterns must not start
with `/` or contain `..`. A pattern that matches no skills fails the invocation.

### Loading and Troubleshooting Skills

Skills are fetched on the first invocation of a session and reused within that
session. Start a new session when testing changes to a remotely hosted skill.
The environment needs network access to the Git or S3 source and any permissions
needed to retrieve it.

If a skill fails to load, check the source path, the presence of `SKILL.md`, the
execution role's access, and private Git credentials. For a filesystem source,
check the path inside the Harness environment rather than on your laptop.
For bundled AWS skills, check the catalog path and whether the environment
contains the bundle. Missing or inaccessible skill sources fail the invocation
rather than being silently skipped.

Exporting a Harness to a code-owned Runtime has additional limits: filesystem
skills are rejected, and bundled AWS skills are omitted with an explanation in
`EXPORT_NOTES.md`. S3 and Git sources are supported by the exporter. See
[Export a Harness](../command.md#agentcore-export-harness).

See [Harness skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-skills.html)
and the [Agent Skills format](https://agentskills.io/specification) for source
behavior and skill authoring.

## Conversation Context and Invocation Limits

`truncation` controls the conversation sent to the model. It does not delete
events saved in Memory. The generated file selects `sliding_window`:

```yaml
truncation:
  strategy: sliding_window
  config:
    slidingWindow:
      messagesCount: 40
```

To summarize older messages instead:

```yaml
truncation:
  strategy: summarization
  config:
    summarization:
      summaryRatio: 0.3
      preserveRecentMessages: 10
      summarizationSystemPrompt: |
        Keep decisions, important facts, and unresolved questions.
```

`summaryRatio` is from 0 to 1. `preserveRecentMessages` is a nonnegative integer.
Summary instructions are inline text, not a local filename.
For `strategy: none`, omit `config`. A `sliding_window` strategy must use
`config.slidingWindow`, and `summarization` must use `config.summarization`.

The following limits apply to one invocation across all its model calls:

```yaml
maxIterations: 15
maxTokens: 20000
timeoutSeconds: 300
```

`maxIterations` limits agent-loop iterations, `maxTokens` limits total output
tokens, and `timeoutSeconds` limits invocation duration in seconds. Each is a
positive integer. Omitting one sends no override, not a promise of unlimited
execution. These limits are separate from `maxTokens` inside the selected model
configuration and from session lifetime.
See [Harness limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html#harness-limits)
for service defaults and quotas.

## Environment and Containers

### Environment Variables

Values in `environmentVariables` must be strings. Quote numbers and booleans:

```yaml
environmentVariables:
  LOG_LEVEL: info
  FEATURE_ENABLED: "true"
  RETRY_LIMIT: "3"
```

These values are stored as plaintext configuration. Do not put API keys or
tokens here. Project deployment accepts at most 50 variables, with keys from
1 to 100 characters matching `[a-zA-Z_][a-zA-Z0-9_]*`. CDK enforces the
CloudFormation value limit of 2048 characters.

### Custom Containers

Omit both `dockerfile` and `environmentArtifact` to use the service-provided environment.
Set `dockerfile` to build a custom environment:

```yaml
dockerfile: Dockerfile
```

The path is relative to the directory containing `harness.yaml`. If supplied
through `agentcore add harness --dockerfile`, the CLI copies the file into the
harness directory as `Dockerfile`.

Alternatively, reference a pre-built ECR image:

```yaml
environmentArtifact:
  containerConfiguration:
    containerUri: 123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest
```

Do not set both fields. Pre-built images must target `linux/arm64`. A custom
image supplies software and files for the managed agent, not a replacement
agent entrypoint. The Harness does not run the image's normal `ENTRYPOINT` or
`CMD`. See [Harness environment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-environment.html).

## Networking and Authentication

### Network Access

Omitting network settings uses PUBLIC mode. To use your VPC, set
`environment.agentCoreRuntimeEnvironment.networkConfiguration`:

```yaml
networkConfig:
  vpcId: vpc-0123456789abcdef0
environment:
  agentCoreRuntimeEnvironment:
    networkConfiguration:
      networkMode: VPC
      networkModeConfig:
        subnets:
          - subnet-0123456789abcdef0
        securityGroups:
          - sg-0123456789abcdef0
```

`subnets` and `securityGroups` are required in VPC mode. `vpcId` is additionally
required for Dockerfile builds because CodeBuild cannot infer it from subnets.
The build infrastructure must be able to reach its dependencies, and the running
environment must be able to reach models, tool endpoints, and skill sources.
Private Git repositories and other public endpoints require suitable egress.

Remove `networkModeConfig` and the project-only `networkConfig` when switching back to `PUBLIC`. Container builds in VPC
mode allow at most five security groups. Other configurations accept up to 16.
VPC container builds within a project share build infrastructure and must use
the same VPC.

### Caller Authentication

Omitting `authorizerConfiguration` uses AWS IAM caller authorization.
For JWT authentication, supply:

```yaml
authorizerConfiguration:
  customJWTAuthorizer:
    discoveryUrl: https://id.example.com/.well-known/openid-configuration
    allowedAudience:
      - my-harness-app
```

The discovery URL must use HTTPS and end in
`/.well-known/openid-configuration`. Set at least one of `allowedAudience`,
`allowedClients`, `allowedScopes`, or `customClaims` to restrict accepted tokens.
Private identity-provider endpoints can also use `privateEndpoint` and
`privateEndpointOverrides`. See the
[authorizer schema](../src/projectSchemas/auth.ts) for those advanced structures.
Remove `authorizerConfiguration` when using `AWS_IAM`.

Caller authentication is separate from the credentials the Harness uses to call
models, tools, or skill sources. For service authentication behavior, see
[Harness security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html).

### Execution Role

Deployment creates an execution role when `executionRoleArn` is omitted.
To supply an existing role:

```yaml
executionRoleArn: arn:aws:iam::123456789012:role/MyHarnessRole
```

CDK cannot modify a supplied role. Add the required model, tool, skill-source,
and storage permissions to that role yourself. Loading a skill or adding a tool
does not bypass IAM permissions or network restrictions.

## Session Lifetime and Storage

`environment.agentCoreRuntimeEnvironment.lifecycleConfiguration` controls the lifetime of the underlying Runtime session, not
the duration of a single invocation:

```yaml
environment:
  agentCoreRuntimeEnvironment:
    lifecycleConfiguration:
      idleRuntimeSessionTimeout: 900
      maxLifetime: 28800
```

Both values are seconds, from 60 to 28800. `idleRuntimeSessionTimeout` cannot
exceed `maxLifetime`.

Session storage preserves files across stop/resume cycles for the same session
ID and does not require VPC mode:

```yaml
environment:
  agentCoreRuntimeEnvironment:
    filesystemConfigurations:
      - sessionStorage:
          mountPath: /mnt/session
```

EFS and S3 Files mounts use existing access points and require VPC mode:

```yaml
environment:
  agentCoreRuntimeEnvironment:
    networkConfiguration:
      networkMode: VPC
      networkModeConfig:
        subnets:
          - subnet-0123456789abcdef0
        securityGroups:
          - sg-0123456789abcdef0
    filesystemConfigurations:
      - efsAccessPoint:
          accessPointArn: arn:aws:elasticfilesystem:us-west-2:123456789012:access-point/fsap-0123456789abcdef0
          mountPath: /mnt/shared
      - s3FilesAccessPoint:
          accessPointArn: arn:aws:s3files:us-west-2:123456789012:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0
          mountPath: /mnt/data
```

The file supports at most two EFS and two S3 Files mounts. Each mount path must
have exactly one directory under `/mnt`, such as `/mnt/shared`, and be unique
across session storage, EFS, and S3 Files. Do not reuse a path with only a trailing
slash added. These settings mount filesystems, not AgentCore conversation Memory.
See [Runtime filesystem configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
for networking and access-point prerequisites.

## Tags

```yaml
tags:
  team: support
  environment: development
```

Tag values are strings. Keys are 1-128 characters, values are at most 256
characters, and `aws:` is reserved. Project and resource tags are merged during
deployment, with resource values taking precedence. The merged resource tag set
must stay within the 50-tag limit.

## Validation

Malformed YAML, duplicate keys, and schema violations fail the read.
Unknown root fields and model variants are rejected. Nested configurations use
their existing validation rules. Use the names and nesting shown in this guide.

Free-form maps such as headers and tool input schemas accept user-defined keys.
Tags and environment variables have their own key and value constraints.
Build, deploy, and export do not rewrite harness YAML or remove its comments.
The project registry in `agentcore.json` uses schema version 2. Deployment targets,
JSON CLI flags/output, and service payloads do not use YAML.
