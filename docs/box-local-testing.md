# Local testing: a Box project with a workspace CLI and L3 constructs

This guide creates, builds, and deploys a Box project with the AgentCore CLI and the
`@aws/agentcore-cdk` L3 constructs taken from your local workspace, not the published
packages. Use it to test the Box gateway, its egress targets, and API key credentials
end to end before you publish.

A "Box project" (`"projectType": "box"` in `agentcore.json`) runs its agent in a _box_:
a sandbox that controls the agent's network egress and filesystem access. Each runtime
gets its own Box gateway, bound to it by `boundRuntime` and named after it: the runtime `agent`
gets `agent-box-egress`.

## Where box comes from

A Box project ships box inside its deploy artifact, so the agent runs in a box on AgentCore
Runtime. Each box runtime names its box release in `agentcore.json` with
`"box": { "version": "<version>" }`, which `agentcore create` writes. `agentcore build` and
`agentcore deploy` download that release's Linux build from
[mquang-amazon/box-releases](https://github.com/mquang-amazon/box-releases) once into
`~/.agentcore/box/`, check its SHA-256s, and stage it into the zip, for a CodeZip runtime. For a
container they write the release and its checksum into `.box-dist/box-release.env` instead.
A container image downloads the Linux build while it builds, under `agentcore dev` too. For a
CodeZip agent, `agentcore dev` runs the `box` on your PATH: download the build for your machine
from the release, unpack it into a folder, and add that folder to your PATH. The pinned release,
`0.1.11-preview.10`, has builds for macOS on an Apple chip and for Linux arm64. When it has no build
for your machine, use the build of `0.1.11-linux-preview.7`, the first box that reads the profiles
the CLI writes, or of a later release.
No local box checkout is needed.

Dev, build and deploy run a runtime's agent in a box only when `agentcore.json` has
`"projectType": "box"` and the runtime has `"box": { "version": ... }`. `create` writes both, and
only for the box templates. The runtime's entry point and Dockerfile never decide it, so your own
`start.py` runs the usual way. A runtime with `box.version` in a project without
`"projectType": "box"` stops dev with `agentcore.json has no "projectType": "box"`.

`box.version` must be the box version the CLI pins in
`src/core/project/backends/boxRelease.json`; build, deploy and container `dev` stop on any other version. To try an
unreleased box build, publish it as a pre-release with the same file names and run
`bun scripts/bump-box-release.ts --box <version>` in your CLI checkout, then set `box.version` to it.

## Prerequisites

- A local checkout of the CLI and of `@aws/agentcore-cdk`.
- AWS credentials for a **dev or test** account. Build writes the Box gateway's Bedrock and
  Memory targets for `AWS_REGION` (else your AWS profile's region), and deploy for its target's
  region.
- `bun` for the CLI, `npm` for the generated CDK app.

## Settings

Set these once per shell. Change the values for your machine.

```
# The CLI, run from source. Point at your workspace checkout.
CLI=/path/to/workspace/agentcore-cli/src/index.ts

# The local L3 constructs checkout.
L3=/path/to/workspace/agentcore-l3-cdk-constructs

# Where the demo project goes.
DEMO=/tmp/cliDemo
PROJECT=cliDemo
```

## Install the CLI's dependencies

The CLI runs from source, so it needs its own `node_modules`. Install them once in the
CLI checkout before the first `bun run "$CLI"`. Without this, `bun` falls back to its global
cache and `create` fails with `ENOENT while resolving package '@opentelemetry/core'`.

```
cd "$(dirname "$CLI")/.."
bun install
```

## 1. Get AWS credentials

Deploy creates real resources, so it needs write access. This example uses `ada` with an
Isengard dev account; use whatever grants credentials for your dev account.

```
ada credentials update --account <your-dev-account> --provider isengard --role Admin
```

## 2. Build and pack the local L3 constructs

`npm pack` makes a tarball you install into the generated CDK app. This is more reliable than a
`file:` dependency.

```
cd "$L3"
npm run build
npm pack
```

## 3. Create the project with the workspace CLI

```
rm -rf "$DEMO/$PROJECT"
mkdir -p "$DEMO"
cd "$DEMO"
bun run "$CLI" create --name "$PROJECT" --template agent-python-strands-box-container
```

Add `--containment private-vpc` to also run the runtime in its own private VPC with no internet
path.

## 4. (Optional) add an egress credential to test

This adds an `[egress]` entry for `api.github.com` with a `github` API key credential. An entry
needs `destinations`. Build declares the credential from the `env://` secret, adds the
`egress-github` gateway target, and deploy provisions the credential in AgentCore Identity.

The `destinations` key lists the hosts the credential may reach. The box blocks the
credential's egress to any host not in the list. Each entry is a `<host>` or
`<host>:<port>` string. The default port is 443. A port must be 1 to 65535.

```
printf '\n[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n' >> "$DEMO/$PROJECT/.box/agent/local/profile.toml"
```

### What build and deploy do with the box profile

Build and deploy read each runtime's own `.box/<runtime>/local/profile.toml` and the policy files
it lists under `policies`, and turn them into that runtime's Box network. They change nothing in
`.box/<runtime>/local/`. They stage the Runtime profile, its policy files, and box in the
`.box-dist/` folder of the code folder or of the build context, and write a copy of the profile,
the generated packs, and the policy files into `.box/<runtime>/aws/` for you to read.

- **Gateway targets.** Each host or `host:port` that an `[egress]` entry or a policy permit
  names, and that the policy allows at least one request to, gets one passthrough target on
  `<runtime>-box-egress`. A host the gateway already has a target for keeps that target. Build owns
  only the targets it wrote, which it lists in `agentcore/box-gateway-targets.json`: it adds them,
  changes them, and removes one when no host needs it. It never changes another target, also one
  whose name starts with `egress-`. For a gateway that the file does not list, which an older CLI
  built, build takes each `egress-` target that has the shape it writes as its own, once.
- **Outbound auth.** An `aws://` secret signs with the gateway's role, an `env://` secret
  sends an API key from AgentCore Identity, and an entry with no secret sends no credential.
- **Failures.** A wildcard host, a plain-HTTP-only host, an unsupported secret or pack, an
  MCP server over HTTP, and similar cases stop build and deploy. The error lists every
  failure with its rule or entry and its `file:line:column`, and nothing is written.
- **Warnings.** Build warns when Box enforces rules that the gateway does not (a path,
  method, or forbid), when an entry's host gets no target, and when a target is signed for an
  AWS service that no policy of the gateway's role grants.
- **The AgentCore Runtime profile.** Build derives `.box-dist/profile.toml` from the local
  profile. Each key of the local profile stays, and build changes
  only what must differ on AgentCore Runtime:
  - each `[egress]` host with a gateway target becomes one route to `<runtime>-box-egress`: the
    first host of an entry keeps the name of the entry, so a pack's own entry of that name merges
    with it, and each other host gets `[egress.<target>]`; an HTTP `[mcp.<name>]` server gets the
    same gateway backend;
  - the agent command, env, filesystem and ingress get their Runtime values: no `--reload`, no
    `LOCAL_DEV`, no `AWS_PROFILE`, the region of the Runtime in place of your own, and the first
    ingress on `0.0.0.0` on the port of the protocol;
  - for CodeZip, each path of the code folder moves to the unpacked zip, and the venv's Python to
    the Runtime's Python, in every table: the agent, each stdio `[mcp.<name>]` server, each
    `[tool.<name>]`;
  - the `@box/agentcore` packs, the project name, and the build region come in, and each CloudWatch
    target signs with the execution role.

  **The default log target.** With no `cloudwatch_logs` target, the Runtime profile gets
  `[telemetry.agentcore]`: box sends its deny, permit, and trace records to the log group of the
  runtime, `/aws/bedrock-agentcore/runtimes/<runtime ID>-DEFAULT`, log stream `otel-rt-logs`. box
  reads these two names from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`, which the Runtime sets. If the
  Runtime does not set it, box does not start. The Runtime makes that log group, so its retention
  applies, and it stays after you remove the runtime. CloudWatch Logs charges for the records it
  gets. To send none, set `DISABLE_ADOT_OBSERVABILITY` to `"true"` in the `envVars` of the runtime
  in `agentcore.json`. To send them to another log group, add a `cloudwatch_logs` target to the
  local profile. `agentcore create` and `agentcore add runtime` give this notice for each box
  runtime.

  Build stops, and names the key and its line, for a value that cannot work on the Runtime: a
  required grant or a command path in the project outside the code folder, in the venv, or in a
  home folder (`${{ home }}`, `~`, `/Users`, `/home`); a CodeZip program that `PATH` finds, such as
  `npx`; a CodeZip write grant in the code folder; `network.contain_egress = false`; a CloudWatch
  target that box refuses; or a telemetry target that is not CloudWatch or `file`. Build warns, and
  goes on, for what the Runtime does without: a `deny` entry or an optional grant with no place
  there, a `deny` entry on the venv (the venv is the code folder on the Runtime), a `file` telemetry
  target, and a program at an absolute path of the system, which build cannot see. Each policy file
  is copied beside the profile, byte for byte.

  Under `agentcore dev`, the CodeZip templates give the box `[project] access = "write"`, and box
  then refuses a stdio server or a tool whose program is the venv's Python ("a link out of a folder
  the box can write"). To run one, set `access = "read"` in `[project]` of the local profile.

- **No-auth targets need a newer L3.** A passthrough target with no outbound auth synthesizes
  only with an `@aws/agentcore-cdk` that accepts it. Until that release is pinned, use a
  local L3 build, as in step 5.

## 5. Point the generated CDK app at the local L3 tarball

```
cd "$DEMO/$PROJECT/agentcore/cdk"
npm install --no-audit --no-fund
rm -rf node_modules/@aws/agentcore-cdk
npm install "$L3"/aws-agentcore-cdk-*.tgz
```

## 6. Build

Export `GITHUB_TOKEN` before build. Build reads it and writes its value into
`agentcore/.env.local` under the credential's reserved name `AGENTCORE_CREDENTIAL_GITHUB`.
On a later build it replaces that value when `GITHUB_TOKEN` holds a different key, as after a
rotation, so deploy provisions the key `agentcore dev` uses. Build reads `GITHUB_TOKEN` as dev
does: from your shell, or from `agentcore/.env.local` when the shell has none. So a
`GITHUB_TOKEN` line in `agentcore/.env.local` replaces the stored key too, even with an older
key; keep the key in one place. With `GITHUB_TOKEN` in neither, build keeps the stored key.

```
cd "$DEMO/$PROJECT"
export GITHUB_TOKEN=ghp_demo_value
bun run "$CLI" build
grep AGENTCORE_CREDENTIAL_GITHUB agentcore/.env.local
```

If you added the `github` egress credential in step 4, this first standalone `build` stops
after writing the targets, policies, and `.env.local`, with:

```
Project build cannot resolve credential "github" before its first deployment.
Run 'agentcore deploy' to provision the credential and build the project.
```

This is expected. An `env://` credential must exist in AgentCore Identity before synthesis can
resolve it, and only `deploy` provisions it. So on the **first** run with an egress credential,
skip straight to step 7: `deploy` provisions the credential and then builds in one step (keep
`GITHUB_TOKEN` exported). After that first deploy, `build` runs standalone as above.

## 7. Deploy

```
bun run "$CLI" deploy
```

Deploy synthesizes the CDK app you linked in step 5, so the stack uses your local L3 constructs.
The first deploy makes the `default` target from your account and region.

## 8. Verify the gateway, its targets, and the credential

Local checks, in `agentcore/agentcore.json`:

- `"projectType": "box"`.
- A gateway named `agent-box-egress` with a `bedrock` passthrough target in the deploy region, and an
  `egress-github` target for `https://api.github.com`.
- A credential named `github` with `authorizerType: ApiKeyCredentialProvider`.

Live checks, after deploy:

```
bun run "$CLI" gateway list
bun run "$CLI" identity api-key-credential-provider get --name github
```

## 9. Tear down

Deploy bills you while resources exist. Remove them when done.

```
bun run "$CLI" remove all --yes
bun run "$CLI" deploy
```

## Troubleshooting

- **Build cannot download box.** The error names the release URL. Check your network; a 404
  means the pinned version is not published in `mquang-amazon/box-releases`.
- **`create` fails with `ENOENT while resolving package '@opentelemetry/core'`.** The CLI's
  dependencies are not installed, so `bun` fell back to its global cache. Run `bun install` in
  the CLI checkout (see "Install the CLI's dependencies").
- **Build says it cannot resolve credential "github" before its first deployment.** Expected
  when step 4's egress credential has never been deployed. Run `agentcore deploy` instead; it
  provisions the credential and builds. Standalone `build` works after that. See step 6.
- **Deploy says a credential has no secret.** The credential's value did not reach
  `agentcore/.env.local`. Export `GITHUB_TOKEN` and run build again, or set
  `AGENTCORE_CREDENTIAL_GITHUB` in the deploy environment.
- **The CDK app uses the published constructs, not yours.** Redo step 5. Confirm with
  `cat agentcore/cdk/node_modules/@aws/agentcore-cdk/package.json`.
