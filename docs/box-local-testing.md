# Local testing: a Box project with a workspace CLI and L3 constructs

This guide creates, builds, and deploys a Box project with the AgentCore CLI and the
`@aws/agentcore-cdk` L3 constructs taken from your local workspace, not the published packages. Use
it to test the Box gateway, its egress targets, and API key credentials end to end before you
publish.

A "Box project" (`"projectType": "box"` in `agentcore.json`) runs its agent in a _box_: a sandbox
that controls the agent's network egress and filesystem access. Each runtime gets its own Box
gateway, bound to it by `boundRuntime` and named after it: the runtime `agent` gets
`agent-box-egress`.

## Where box comes from

A Box project ships box inside its deploy artifact, so the agent runs in a box on AgentCore Runtime.
Each box runtime names its box release in `agentcore.json` with `"box": { "version": "<version>" }`,
which `agentcore create` writes and build keeps at the pinned release. `agentcore build` and
`agentcore deploy` download the pinned release's Linux build from
[strands-agents/box](https://github.com/strands-agents/box/releases) once into
`~/.agentcore/box/`, check its SHA-256s, and stage it into the zip, for a CodeZip runtime. For a
container they write the release and its checksum into `.box-dist/box-release.env` instead. A
container image downloads the Linux build while it builds, under `agentcore dev` too. For a CodeZip
agent, `agentcore dev` runs the `box` on your PATH: install it as in [Install box](#install-box). No
local box checkout is needed.

Dev, build and deploy run a runtime's agent in a box only when `agentcore.json` has
`"projectType": "box"` and the runtime has `"box": { "version": ... }`. `create` writes both, and
only for the box templates. The runtime's entry point and Dockerfile never decide it, so your own
`start.py` runs the usual way. A runtime with `box.version` in a project without
`"projectType": "box"` stops dev with `agentcore.json has no "projectType": "box"`.

Every box runtime runs the box version the CLI pins in `src/core/project/backends/boxRelease.json`.
Build and deploy set each runtime's `box.version` to it, and say so when it named another; container
`dev` stages the pinned box whatever `box.version` says. To try an unreleased box build, publish it
as a GitHub pre-release with the release's file names (the `box-cli-v<version>-aarch64-apple-darwin`
and `box-cli-v<version>-aarch64-unknown-linux-gnu` archives and `SHA256SUMS.txt`), for example in a
fork of [strands-agents/box](https://github.com/strands-agents/box), then run
`bun scripts/bump-box-release.ts --box <version> --box-repo <owner/repo>` in your CLI checkout. Add
`--darwin-box <version>` to take the macOS build from another release of the same repository.

## Prerequisites

- A local checkout of the CLI and of `@aws/agentcore-cdk`. The L3 checkout must have
  [aws/agentcore-l3-cdk-constructs#470](https://github.com/aws/agentcore-l3-cdk-constructs/pull/470),
  as its `box-integration` branch does. The Box gateway that `create` writes has
  `enableApplicationLogs`, and an older L3 refuses it at synth with a `ConfigValidationError`.
  A boxed runtime with Memory also needs
  [aws/agentcore-l3-cdk-constructs#481](https://github.com/aws/agentcore-l3-cdk-constructs/pull/481): it gives the
  runtime's role its Memory grant, and a `PRIVATE_VPC` runtime the AgentCore endpoint of its private VPC. Without it,
  the box cannot reach Memory.
- `box` `0.3.0` on your `PATH`, the release the CLI pins. Use that release: the box
  features and the profiles that the CLI writes change together, so an older box can refuse the
  profiles. The CLI does not check the version of the box on your `PATH` yet. Build, deploy and dev
  run it to read the box profile with `box profile show --format json --full`, and CodeZip dev runs
  the agent with it. See [Install box](#install-box).
- AWS credentials for a **dev or test** account. Build writes the Box gateway's Bedrock target and
  the Runtime profile's direct AgentCore route for `AWS_REGION` (else your AWS profile's region), and
  deploy for its target's region.
- `bun` for the CLI, `npm` for the generated CDK app.

## Install box

box ships as a release archive per machine on
[strands-agents/box](https://github.com/strands-agents/box/releases). The CLI uses the `box-cli-v<version>-*` archives, with builds
for macOS on an Apple chip (`aarch64-apple-darwin`), Linux arm64 (`aarch64-unknown-linux-gnu`) and
Linux x86_64 (`x86_64-unknown-linux-gnu`). The release's `box-v<version>-*` archives hold box
without its packs; do not use them. Each `box-cli` archive unpacks flat: `box`, its two helpers,
`release.json`, and `resources/` (box's packs, which it finds beside itself).

Download the archive for your machine, check it, and unpack it into a versioned folder. On macOS, do
not unpack it into a folder named `box`: macOS reads a folder `box` that holds the executable `box` as
a bundle, reports its signature as invalid (`invalid Info.plist`), and kills box at launch.

macOS on an Apple chip:

```
mkdir -p ~/.local/share/box/0.3.0 && cd ~/.local/share/box/0.3.0
curl -fSLO https://github.com/strands-agents/box/releases/download/v0.3.0/box-cli-v0.3.0-aarch64-apple-darwin.tar.gz
curl -fSLO https://github.com/strands-agents/box/releases/download/v0.3.0/SHA256SUMS.txt
grep box-cli-v0.3.0-aarch64-apple-darwin SHA256SUMS.txt | shasum -a 256 -c -
tar -xzf box-cli-v0.3.0-aarch64-apple-darwin.tar.gz
```

Linux arm64:

```
mkdir -p ~/.local/share/box/0.3.0 && cd ~/.local/share/box/0.3.0
curl -fSLO https://github.com/strands-agents/box/releases/download/v0.3.0/box-cli-v0.3.0-aarch64-unknown-linux-gnu.tar.gz
curl -fSLO https://github.com/strands-agents/box/releases/download/v0.3.0/SHA256SUMS.txt
grep box-cli-v0.3.0-aarch64-unknown-linux-gnu SHA256SUMS.txt | sha256sum -c -
tar -xzf box-cli-v0.3.0-aarch64-unknown-linux-gnu.tar.gz
```

The check must print `OK`.

Put the folder first on your `PATH`, for this shell and for new ones (use `~/.bashrc` for bash).
`BOX_VERSION` is the folder you unpacked into, `0.3.0`.

```
BOX_VERSION=0.3.0
export PATH="$HOME/.local/share/box/$BOX_VERSION:$PATH"
grep -q "share/box/$BOX_VERSION" ~/.zshrc || echo "export PATH=\"\$HOME/.local/share/box/$BOX_VERSION:\$PATH\"" >> ~/.zshrc
```

The `grep -q ... ||` adds the line only once, so running it again does not repeat it. When you move
to a newer release, edit that line in `~/.zshrc` rather than adding another.

Check it:

```
which box
box --version
```

- `which box` must name the folder you unpacked into. An older `box` earlier on your `PATH` (a
  source build, or Box Core's `box` in `/usr/local/bin`) wins otherwise.
- `box --version` should print the pinned `box 0.3.0` (from
  `src/core/project/backends/boxRelease.json`). An older box can refuse the profiles that the CLI
  writes.
- On macOS, if Gatekeeper refuses to run `box`, clear the download flag with
  `xattr -dr com.apple.quarantine "$HOME/.local/share/box/0.3.0"`.

To move to a newer release, unpack it into its own folder the same way and change the `PATH` line to
that folder.

## Settings

Set these once per shell. Change the values for your machine: `CLI` is the CLI run from source in
your workspace checkout, `L3` is the local L3 constructs checkout, and `DEMO` and `PROJECT` say
where the demo project goes. Use absolute paths: the steps below `cd` into other folders, where a
relative path no longer resolves (`bun` then says
`Module not found "./agentcore-cli/src/index.ts"`). Replace `/path/to/workspace` with the folder
that holds both checkouts:

```
CLI=/path/to/workspace/agentcore-cli/src/index.ts
L3=/path/to/workspace/agentcore-l3-cdk-constructs
DEMO=/tmp/cliDemo
PROJECT=cliDemo
```

Check that both paths exist. This prints `ok`, or nothing if a placeholder is still there:

```
test -f "$CLI" && test -d "$L3" && echo ok
```

Write `$HOME`, not `~`, inside quotes: the shell expands `~` only outside quotes, so `CLI="~/..."`
makes bun look for a folder named `~`.

## Install the CLI's dependencies

The CLI runs from source, so it needs its own `node_modules`. Install them once in the CLI checkout
before the first `bun run "$CLI"`. Without this, `bun` falls back to its global cache and `create`
fails with `ENOENT while resolving package '@opentelemetry/core'`.

```
cd "$(dirname "$CLI")/.."
bun install
```

## 1. Get AWS credentials

Deploy creates real resources, so it needs write access to a development AWS account. Sign in
with IAM Identity Center, or configure access keys, in the profile you deploy with:

```
aws configure sso --profile <your-dev-profile>
export AWS_PROFILE=<your-dev-profile>
```

`aws configure` works too, for access keys.

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

The `destinations` key lists the hosts the credential may reach. The box blocks the credential's
egress to any host not in the list. Each entry is a `<host>` or `<host>:<port>` string. The default
port is 443. A port must be 1 to 65535.

```
printf '\n[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n' >> "$DEMO/$PROJECT/.box/agent/local/profile.toml"
```

### What build and deploy do with the box profile

Build and deploy run `box profile show .box/<runtime>/local/profile.toml --format json --full` in
the project folder, with the `box` on your `PATH`, and turn the `box.toml` and `policy.dw` that Box
resolves the profile to into the runtime's Box network. Every pack, option, and rule Box adds is
already in them, so any pack works. They change nothing in `.box/<runtime>/local/`. They stage the
Runtime profile, its policy files, and box in the `.box-dist/` folder of the code folder or of the
build context, and write a copy of the profile, the generated packs, and the policy files into
`.box/<runtime>/aws/` for you to read.

The pinned box names its packs `@box/base`, `@box/bedrock`, and `@box/agentcore`. A
profile that names a pack `box/<name>` fails: box refuses it and names the `@box/<name>` pack.

- **Gateway targets.** Each host or `host:port` that an `[egress]` entry, an `[mcp]` server with
  `type = "http"`, or a policy permit names, and that the policy allows at least one request to,
  gets one passthrough target on `<runtime>-box-egress`. The target of an MCP server is
  `egress-<server>`. Its `protocolType` is `CUSTOM`, thus only Box makes the decision on each
  `mcp:call`. A host the gateway already has a target for keeps that target. Build owns only the
  targets it wrote, which it lists in `agentcore/box-gateway-targets.json`: it adds them, changes
  them, and removes one when no host needs it. It never changes another target, also one whose name
  starts with `egress-`. `agentcore add gateway-target` refuses the names `bedrock`, `agentcore`,
  and `egress-*` on a Box gateway, so such a target comes only from an edit by hand or an older CLI.
  `agentcore create` and `agentcore add runtime` write an empty entry for
  each new Box gateway, so build owns none of its targets until it writes one. For a gateway that
  the file does not list, which an older CLI made, build takes each `egress-` target that has the
  shape it writes as its own, once, and warns for each other `egress-` target, which it keeps as
  yours. Commit `agentcore/box-gateway-targets.json` with `agentcore.json`: in a clone without it,
  build goes back to that `egress-` rule, and can take or give up the wrong targets. The
  `.gitignore` that `agentcore create` writes does not exclude it. Build writes the file, but you
  edit it in one case: when you change a target that build wrote, build stops and tells you to
  remove that target's name from the file to keep the target as yours. Then build no longer records,
  changes, or removes it.
- **The other gateways of the project.** A runtime without a box gets each gateway without
  `boundRuntime` in `AGENTCORE_GATEWAY_<NAME>_URL`. For a box runtime, each of these gateways gets
  the target `egress-gateway-<name>` on `<runtime>-box-egress`, with `passthrough.gateway` set to
  the gateway's name. The L3 sets the target's endpoint to that gateway's URL, gives the Box
  gateway's role `bedrock-agentcore:InvokeGateway` on that gateway only, and sets
  `AGENTCORE_GATEWAY_<NAME>_URL` and `_HOST` on the runtime. A `PRIVATE_VPC` runtime gets none of
  them. A `CUSTOM_JWT` gateway gets no target, and `agentcore add gateway`, and `agentcore add runtime` for a
  box runtime, give one notice for it. The file
  `agentcore/box-gateway-targets.json` lists these targets too. You write nothing for them. A profile
  entry that signs for a gateway host with `aws://` stops build. Build writes these targets only when
  the `@aws/agentcore-cdk` in `agentcore/cdk` accepts `passthrough.gateway`: it asks that library
  with `node`. When the library refuses the field, build writes none of them, removes the ones it
  wrote before, and gives one warning. When build cannot do the check (no `node_modules`, no `node`,
  a check that takes more than 60 seconds, or one that fails), it stops and writes nothing.
- **Outbound auth.** An `aws://` secret signs with the gateway's role, an `env://` secret
  sends an API key from AgentCore Identity, and an entry with no secret sends no credential.
  This includes the model-provider route that `agentcore create` writes when you give it no key,
  such as `[egress.openai]` with `env://OPENAI_API_KEY` (also for Anthropic and Gemini). When that
  key is set in your shell or in `agentcore/.env.local`, build adds an API key credential such as
  `openai`, and deploy provisions your key in AgentCore Identity.
- **Failures.** A profile Box refuses stops build and deploy with box's own error. A wildcard
  host, a plain-HTTP-only host, an unsupported secret, an MCP server that names more than one
  host, a path, or a port other than 443, and similar cases stop them too. The error starts with `Build stopped:` or `Deploy stopped:` and the
  number of problems, then gives one line for each problem: its `file:line:column` in your
  profile or policy file, what is wrong, and how to fix it. A rule of your policy file is found
  by its `@id`. For a rule that Box adds, the line names the entry that makes Box add it, such as
  `[egress.github]`. Nothing is written.
- **Warnings.** Build warns when Box enforces rules that the gateway does not (a path,
  method, or forbid), when an entry's host gets no target, and when a target is signed for an
  AWS service that no policy of the gateway's role grants. It also warns for a `.json` file in
  the gateway's `additionalPolicies` that does not exist, cannot be read, or is not a JSON
  object, as it counts none of its actions.
- **The AgentCore Runtime profile.** Build derives `.box-dist/profile.toml` from the local
  profile. Each key of the local profile stays, and build changes only what must differ on
  AgentCore Runtime:
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
    target signs with the execution role;
  - with `instrumentation.enableOtel` on, which is the default for a box template too, a command of
    the Python of the venv starts with `opentelemetry-instrument`. On CodeZip, the Python of the
    Runtime runs the script in the zip, `<code>/bin/opentelemetry-instrument`. The `@box/agentcore`
    pack gives the agent the ADOT variables and the `OTEL_RESOURCE_ATTRIBUTES` that the Runtime
    sets. When your `[agent.env]` sets one of these variables, box uses your value. The pack sets no
    `OTEL_EXPORTER_OTLP_*` variable, because box sets each one;
  - each other gateway of the project gets `[mcp.<gateway>]`, to the host that `@box/agentcore`
    reads from `AGENTCORE_GATEWAY_<NAME>_HOST`, through its `egress-gateway-<name>` target. The agent
    gets `AGENTCORE_GATEWAY_<NAME>_URL`, so the code that calls the gateway without a box works in
    the box. Box permits each tool of the server, and a forbid rule of your policy still applies.
    A server of your profile with the name of a gateway stops build.

  **The default log target.** With no `cloudwatch_logs` target, the Runtime profile gets
  `[telemetry.agentcore]`: box sends its deny, permit, and trace records to the log group of the
  runtime, `/aws/bedrock-agentcore/runtimes/<runtime ID>-DEFAULT`, log stream `otel-rt-logs`. box
  reads these two names from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`, which the Runtime sets. If the
  Runtime does not set it, box does not start. The Runtime makes that log group, so its retention
  applies, and it stays after you remove the runtime. CloudWatch Logs charges for the records it
  gets. To send none, set `DISABLE_ADOT_OBSERVABILITY` to `"true"` in the `envVars` of the runtime
  in `agentcore.json`. Then the Runtime profile also gets no default X-Ray target. The agent does
  not start with `opentelemetry-instrument`, and the `@box/agentcore` pack gives it no ADOT
  variable. To send the records to another log group, add a `cloudwatch_logs` target to the local
  profile. `agentcore create` and `agentcore add runtime` give this notice for each box runtime.

  **The default X-Ray target.** With `enableOtel` on and no `cloudwatch_traces` target, the Runtime
  profile gets `[telemetry.agentcore_traces]`: box sends the spans of the agent, and its own deny,
  permit, and trace spans, to X-Ray in the region of the Runtime. Build gives the execution role
  `xray:PutSpans` and `xray:PutTraceSegments` in `agentcore/box-telemetry-policy-<runtime>.json`. To
  send the spans to a different target, add a `cloudwatch_traces` target to the local profile. To
  send no spans, set `instrumentation.enableOtel` to `false` in `agentcore.json`. When `enableOtel`
  is on and the agent does not start with `opentelemetry-instrument`, build gives a warning.

  Build stops, and names the key and its line, for a value that cannot work on the Runtime: a
  required grant or a command path in the project outside the code folder, in the venv, or in a home
  folder (`${{ home }}`, `~`, `/Users`, `/home`); a CodeZip program that `PATH` finds, such as
  `npx`; a CodeZip write grant in the code folder; `network.contain_egress = false`; a CloudWatch
  target that box refuses; or a telemetry target that is not CloudWatch or `file`. Build warns, and
  goes on, for what the Runtime does without: a `deny` entry or an optional grant with no place
  there, a `deny` entry on the venv (the venv is the code folder on the Runtime), a `file` telemetry
  target, and a program at an absolute path of the system, which build cannot see. Each policy file
  is copied beside the profile, byte for byte.

  Under `agentcore dev`, the CodeZip templates give the box `[project] access = "write"`, and box
  then refuses a stdio server or a tool whose program is the venv's Python ("a link out of a folder
  the box can write"). To run one, set `access = "read"` in `[project]` of the local profile.

- **No-auth targets need a newer L3.** A passthrough target with no outbound auth synthesizes only
  with an `@aws/agentcore-cdk` that accepts it. Until that release is pinned, use a local L3 build,
  as in step 5. A target with `passthrough.gateway` also needs an L3 that
  accepts that field.

## 5. Point the generated CDK app at the local L3 tarball

```
cd "$DEMO/$PROJECT/agentcore/cdk"
npm install --no-audit --no-fund
rm -rf node_modules/@aws/agentcore-cdk
npm install "$L3"/aws-agentcore-cdk-*.tgz
```

## 6. Test locally with `agentcore dev`

`agentcore dev` runs the agent in a box on your machine, so you can try the project before you
deploy. It deploys nothing. The agent signs its Bedrock calls with the AWS default credential chain
(`secret.ref = "aws://"` in `.box/agent/local/profile.toml`), and Memory is off (`LOCAL_DEV=1`).

Dev runs an agent in a box only in a Box project, as build and deploy do: `agentcore.json` must have
`"projectType": "box"`, which `create` writes for the box templates. Without it, dev runs a runtime
the usual way, and stops on one that has `box.version` with
`agentcore.json has no "projectType": "box"`.

### Which box builds exist

The box release has these builds:

| Machine           | Build                                          | CodeZip dev | Container dev |
| ----------------- | ---------------------------------------------- | ----------- | ------------- |
| macOS, Apple chip | `box-cli-v<version>-aarch64-apple-darwin`      | yes         | yes           |
| Linux, arm64      | `box-cli-v<version>-aarch64-unknown-linux-gnu` | yes         | yes           |
| Linux, x86_64     | `box-cli-v<version>-x86_64-unknown-linux-gnu`  | untested    | no            |
| macOS, Intel      | none                                           | no          | no            |

- The **container** image always uses the Linux arm64 build, because AgentCore Runtime is arm64. It
  runs on an Apple chip Mac through Finch or Docker, and on an arm64 Linux host. An x86 host would
  need to emulate arm64.
- **CodeZip** dev runs the `box` on your `PATH` natively, so it needs the build for your machine. On
  an arm64 Linux host it uses the same Linux build as the Runtime.
- Build and deploy need a `box` on your `PATH` on every machine, to read the profile. So for now
  build and deploy work only on an Apple chip Mac or an arm64 Linux host.

### Before you start

In the shell you run dev from:

```
box --version
aws sts get-caller-identity
```

- `box --version` should print the pinned version. The CLI does not check it, and an older box can
  refuse the profiles that the CLI writes. Dev and build read the profile with
  `box profile show --format json --full`. The AgentCore Runtime profile signs each Box gateway
  backend for `${{ inputs.aws.region }}`, and its default telemetry target reads one key of
  `OTEL_EXPORTER_OTLP_LOGS_HEADERS`. An older box release cannot do all of these.
- The `[default]` profile must hold fresh credentials, because box reads them when dev starts. After
  you refresh them, restart dev.

### Run dev

In the project from step 3, start dev. If you added the `[egress.github]` entry in step 4, first
export `GITHUB_TOKEN`, which that entry reads. A placeholder value is enough for the local check, as
in step 7:

```
cd "$DEMO/$PROJECT"
export GITHUB_TOKEN=ghp_demo_value
bun run "$CLI" dev
```

Dev hands each `env://` key of the box profile (an `[egress]` route's or an `[mcp]` server's) to
`box run` from your shell, and writes it nowhere. A value you put in `agentcore/.env.local` is used
when the shell has none. If neither has it, dev warns, naming the variable and how to set it, and
box then refuses to start (`credential variable GITHUB_TOKEN is not set`). A variable set without
`export` stays in the shell and does not reach dev: export it, or set it on the same line
(`GITHUB_TOKEN=... bun run "$CLI" dev`).

Then, in a second shell in the project folder:

```
bun run "$CLI" invoke --local --runtime agent --payload '{"prompt":"What is 17 times 23?"}'
```

**Container template** (`agent-python-strands-box-container`, the one step 3 creates):

- Dev builds the image with Docker, Podman or Finch. Set `AGENTCORE_CONTAINER_TOOL=finch` (or
  `docker`, `podman`) to pick one. The image downloads the Linux box release while it builds.
- Dev passes your resolved AWS credentials into the container as profile `default`, and refreshes
  them while it runs.
- Invoke once the dev output shows `0.0.0.0:8080 is relayed to the agent's port 8081`.
- The container runs with `--cap-add SYS_ADMIN` and unconfined seccomp, AppArmor and system paths,
  which box's Linux sandbox needs. A container tool that refuses these flags cannot run it.
- The agent has read-only access to `/app`, plus exec on `/app/.venv`, so it can run its venv but
  not change it.

**CodeZip template** (`agent-python-strands-box`; create it in step 3 with
`--template agent-python-strands-box`):

- Dev runs `box run` on `.box/<runtime>/local/profile.toml` from the agent's folder
  (`app/<runtime>`), with the `box` on your `PATH`. The box listens on 8080 and relays to the agent
  on 8081.
- Invoke once the dev output shows `Uvicorn running on http://127.0.0.1:8081`.
- Dev needs the agent's venv: `create` runs `uv sync` in `app/agent`, on a uv-managed Python in
  `~/.local/share/uv/python`, the only Python folder the profile lets box run. With
  `--skip-install`, or to rebuild the venv, run this there first:
  `UV_MANAGED_PYTHON=1 UV_PYTHON_INSTALL_DIR="$HOME/.local/share/uv/python" uv sync`.
- Port 8080 must be free. Dev refuses another port, because the profile's ingress listens on 8080.
- On macOS the box runs under Seatbelt, which cannot start inside another sandbox. Run dev from a
  normal terminal, not from an agent's sandboxed shell.

### What to check

- The answer comes back from `invoke --local`.
- The dev output shows box starting the agent: `box: running profile cliDemo` (your `$PROJECT`) and
  the `[agent]` filesystem summary, with `deny_write  .../.venv  (read-only)` for CodeZip.
- With the step 4 `[egress]` entry, calls to its host go out, and calls to other hosts are blocked
  (`ProxyConnectionError ... 127.0.0.1:<port>` in the agent's log means box blocked the host).

Stop dev with Ctrl+C before you build.

## 7. Build

Export `GITHUB_TOKEN` before build. Build reads it and writes its value into `agentcore/.env.local`
under the credential's reserved name `AGENTCORE_CREDENTIAL_GITHUB`. On a later build it replaces
that value when `GITHUB_TOKEN` holds a different key, as after a rotation, so deploy provisions the
key `agentcore dev` uses. Build reads `GITHUB_TOKEN` as dev does: from your shell, or from
`agentcore/.env.local` when the shell has none. So a `GITHUB_TOKEN` line in `agentcore/.env.local`
replaces the stored key too, even with an older key; keep the key in one place. With `GITHUB_TOKEN`
in neither, build keeps the stored key.

```
cd "$DEMO/$PROJECT"
export GITHUB_TOKEN=ghp_demo_value
bun run "$CLI" build
grep AGENTCORE_CREDENTIAL_GITHUB agentcore/.env.local
```

If you added the `github` egress credential in step 4, this first standalone `build` stops after
writing the targets, policies, and `.env.local`, with:

```
Project build cannot resolve credential "github" before its first deployment.
Run 'agentcore deploy' to provision the credential and build the project.
```

This is expected. An `env://` credential must exist in AgentCore Identity before synthesis can
resolve it, and only `deploy` provisions it. So on the **first** run with an egress credential, skip
straight to step 8: `deploy` provisions the credential and then builds in one step (keep
`GITHUB_TOKEN` exported). After that first deploy, `build` runs standalone as above.

## 8. Deploy

```
bun run "$CLI" deploy
```

Deploy synthesizes the CDK app you linked in step 5, so the stack uses your local L3 constructs. The
first deploy makes the `default` target from your account and region.

## 9. Verify the gateway, its targets, and the credential

Local checks, in `agentcore/agentcore.json`:

- `"projectType": "box"`.
- A gateway named `agent-box-egress` with a `bedrock` passthrough target in the deploy region, and
  an `egress-github` target for `https://api.github.com`.
- A credential named `github` with `authorizerType: ApiKeyCredentialProvider`.

Live checks, after deploy. Deploy names each AWS resource after the project and the deploy target
(`default`), so the names differ from those in `agentcore.json`:

- The Box gateway `agent-box-egress` deploys as `<project>-default-agent-box-egress`, for example
  `cliDemo-default-agent-box-egress`. Its ID is that name in lowercase with a suffix, and is a stack
  output.
- The credential `github` deploys as the API key credential provider `<project>_default_github`, for
  example `cliDemo_default_github`.

```
GATEWAY_ID=$(aws cloudformation describe-stacks --stack-name "AgentCore-$PROJECT-default" --query "Stacks[0].Outputs[?starts_with(OutputKey, 'ApplicationGatewayAgentBoxEgressIdOutput')].OutputValue" --output text)
echo "$GATEWAY_ID"
bun run "$CLI" gateway get --id "$GATEWAY_ID"
bun run "$CLI" identity api-key-credential-provider get --name "${PROJECT}_default_github"
```

`gateway list` shows every gateway in the account and region, not only this project's, so look the
Box gateway up by its ID as above.

## 10. Read box telemetry and gateway logs in CloudWatch

On AgentCore Runtime, box sends each policy decision (permit, deny, trace) to the log group of the
Runtime, `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`, stream `otel-rt-logs`. When the box
profile of the agent has no `cloudwatch_logs` target, build adds the target `[telemetry.agentcore]`
to the Runtime profile. If the profile has a target with the name `agentcore`, the name is
`[telemetry.agentcore_default]`. When the run starts, box fills the region of the target from
`AWS_REGION`, and its log group and stream from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`. The target sends
the deny, permit, and trace records, and box signs it with the execution role.

With `instrumentation.enableOtel` on, box also sends the spans of the agent and its own spans to
X-Ray, through the target `[telemetry.agentcore_traces]`. Build gives the execution role the X-Ray
grant for it. "The default X-Ray target" in step 4 gives the rules. CloudWatch Transaction Search
keeps the spans in the log group `aws/spans`.

The CLI and the L3 constructs make no log group for box. The role that the CDK makes for the runtime
can write to the log group of the Runtime, thus build adds no grant for it. A runtime that names an
`executionRoleArn` must have `logs:CreateLogStream` and `logs:PutLogEvents` on
`/aws/bedrock-agentcore/runtimes/*`.

The `logs runtime` command finds that log group from the runtime name:

```sh
cd "$DEMO/$PROJECT"
bun run "$CLI" logs runtime --name agent --since 15m --query '"strands.box.policy.verdict"'
```

Each record is one decision, with `strands.box.policy.verdict`, `.rule`, and `.resource`. To show
only the deny decisions, use `--query '"deny"'`.

A Box gateway that `create` or `add runtime` writes has `"enableApplicationLogs": true` in
`agentcore.json`, and they tell you so with a notice. Deploy then sends the gateway's
`APPLICATION_LOGS` to `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<gateway ID>`.
This needs an L3 that has
[aws/agentcore-l3-cdk-constructs#470](https://github.com/aws/agentcore-l3-cdk-constructs/pull/470),
as the `box-integration` branch of the L3 does. Set `"enableApplicationLogs": false` to stop the
logs. Traces to X-Ray stay off unless you set `"enableTraces": true`, which needs CloudWatch
Transaction Search in the account and Region. Read the gateway logs with the gateway ID from step 9:

```sh
aws logs tail "/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/$GATEWAY_ID" --since 15m
```

To replace the default target with a log group that you make:

1. Set the region of the log group, then make the log group and the log stream. Box does not make
   them, and deploy does not make them.

   ```sh
   REGION=us-west-2
   aws logs create-log-group --region "$REGION" --log-group-name "/aws/box/$PROJECT"
   aws logs create-log-stream --region "$REGION" --log-group-name "/aws/box/$PROJECT" --log-stream-name agent
   ```

2. Add a target to the box profile of the agent, `.box/agent/local/profile.toml`. Set `region` to
   `$REGION`, the region of the log group:

   ```toml
   [telemetry.logs]
   kind = "cloudwatch_logs"
   region = "us-west-2"             # your $REGION
   log_group = "/aws/box/cliDemo"   # your $PROJECT
   log_stream = "agent"
   include = ["deny", "permit", "trace"]
   secret.ref = "aws://"
   ```

   If the target has no `region`, build writes the region of the `default` target in
   `agentcore/aws-targets.json` into the Runtime profile, or the build region when there is no such
   target, and deploy writes the region of its deploy target. Box does not accept a CloudWatch
   target with no region. Thus `agentcore dev` cannot run the profile until you add `region`.

3. Deploy the project:

   ```sh
   cd "$DEMO/$PROJECT"
   bun run "$CLI" deploy
   ```

   Build copies the table into the Runtime profile, where it replaces the default target. A
   `cloudwatch_traces` target or a third-party target does not replace the default target. On
   AgentCore Runtime, box signs this target with the execution role. Build also writes one policy
   file for each box runtime, `agentcore/box-telemetry-policy-<runtime>.json`, here
   `box-telemetry-policy-agent.json`. It adds the file to the `additionalPolicies` of that runtime.
   The file gives the role `logs:PutLogEvents` on the stream of each `cloudwatch_logs` target, and
   `xray:PutSpans` and `xray:PutTraceSegments` for a `cloudwatch_traces` target.

4. Invoke the agent, then read the records:

   ```sh
   bun run "$CLI" invoke --runtime agent --payload '{"prompt":"What is 17 times 23?"}'
   aws logs tail "/aws/box/$PROJECT" --region "$REGION" --since 15m
   ```

   To show only the deny decisions, add `--filter-pattern '"deny"'`.

### Send box telemetry to Langfuse, LangSmith, or an OTLP endpoint

A box profile can send spans to a third party: `kind = "langfuse"`, `"langsmith"`, or `"otlp"`.
Box sends them from the runtime to the host directly, not through the Box gateway. Build writes no
gateway target for a telemetry host.

1. Get the keys. Use a test project and test data only.
   - Langfuse: in your project, open **Settings > API Keys** and make a key pair. Box takes the two
     keys as one value with a colon between them: `pk-lf-...:sk-lf-...`.
   - LangSmith: open **Settings > API Keys** and make a key (`lsv2_...`).

2. Add the targets to the box profile of the agent, `.box/agent/local/profile.toml`:

   ```toml
   [telemetry.langfuse]
   kind = "langfuse"
   destination = "https://us.cloud.langfuse.com"   # the address of your Langfuse Region
   secret.ref = "env://LANGFUSE_AUTH"

   [telemetry.langsmith]
   kind = "langsmith"
   project = "box-test"
   secret.ref = "env://LANGSMITH_API_KEY"
   ```

3. Export the keys in the shell that runs dev, build, and deploy:

   ```sh
   export LANGFUSE_AUTH='pk-lf-...:sk-lf-...'
   export LANGSMITH_API_KEY='lsv2_...'
   ```

   With `agentcore dev`, box reads each key from its environment variable, for CodeZip and container agents.

4. Build and deploy. AgentCore Runtime does not have these environment variables. Thus:
   - build copies each key into `agentcore/.env.local` as
     `AGENTCORE_CREDENTIAL_<RUNTIME>_TELEMETRY_<TARGET>`, in capital letters with `_` for `-`, for example
     `AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGFUSE`;
   - deploy writes the keys into one AWS Secrets Manager secret for each runtime,
     `agentcore/<project>/<runtime>/box`, with one field for each target, `telemetry.<target>`. The
     secret is not in the CloudFormation stack. Thus, no key goes into a template;
   - the Runtime profile lists the `@box/aws-secrets-manager` plugin, and each target reads
     `aws-secretsmanager://agentcore/<project>/<runtime>/box#telemetry.<target>`;
   - the execution role gets `secretsmanager:GetSecretValue` on that secret only, in
     `agentcore/box-telemetry-policy-<runtime>.json`.

   When the run starts, box reads the keys with the AWS CLI, which is in the container image.
   The agent does not see the keys. A new deploy without the environment variables keeps the keys in
   the secret.
   When no runtime has a key, deploy schedules the deletion of the secret.

5. Check the result:

   ```sh
   aws secretsmanager describe-secret --secret-id "agentcore/$PROJECT/agent/box" --query Name
   bun run "$CLI" invoke --runtime agent --payload '{"prompt":"What is 17 times 23?"}'
   ```

   Then look in Langfuse (the **Tracing** page) and in LangSmith (the project `box-test`). If a send
   does not succeed, set the environment variable `STRANDS_BOX_TELEMETRY_DEBUG` to `1` on the
   runtime in `agentcore.json`. Box then writes the cause of each send that did not succeed to the log
   of the runtime, and it hides the key.

Limits:

- **CodeZip:** box reads the keys with its `@box/aws-secrets-manager` plugin, which runs the `aws`
  program. The CodeZip image of the Runtime does not have `aws`. Build keeps the target and shows a
  warning. Put `aws` on `PATH` in `start.py` before `box run`, or use a container runtime.
- **PRIVATE_VPC:** the private VPC has no internet path. Build keeps the target and shows a warning:
  box tries each send, and no send succeeds until you give the VPC a path to the host, or remove
  `--containment private-vpc`. Build also sets `"secretsManagerEndpoint": true` in the `network` of
  the runtime, so the L3 constructs give the VPC an AWS Secrets Manager endpoint: without it box
  cannot read its keys, and does not start.

## 11. Tear down

Deploy bills you while resources exist. Remove them when done. `--yes` confirms that deploy deletes
the stack, since the project then declares nothing to deploy; without it, deploy stops and asks you
to re-run with `--yes`.

First keep the runtime ID from the stack outputs, because the outputs go with the stack:

```
RUNTIME_ID=$(aws cloudformation describe-stacks --stack-name "AgentCore-$PROJECT-default" --query "Stacks[0].Outputs[?ExportName=='AgentCore-$PROJECT-default-agent-RuntimeId'].OutputValue" --output text)
echo "$RUNTIME_ID"
```

Then remove the resources and the stack:

```
bun run "$CLI" remove all --yes
bun run "$CLI" deploy --yes
```

These outlive the stack. Delete them too:

- The API key credential provider of step 4's `github` credential, `<project>_default_github`:

  ```
  bun run "$CLI" identity api-key-credential-provider delete --name "${PROJECT}_default_github"
  ```

- The log group of the Runtime, `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`. AgentCore
  Runtime makes it, not the stack:

  ```
  aws logs delete-log-group --log-group-name "/aws/bedrock-agentcore/runtimes/$RUNTIME_ID-DEFAULT"
  ```

- The log group from step 10, if you made one:

  ```
  aws logs delete-log-group --region "$REGION" --log-group-name "/aws/box/$PROJECT"
  ```

## Troubleshooting

- **Dev says `'box' was not found on your PATH`.** Download the build for your machine from the box
  release, unpack it into a folder, add that folder to your `PATH`, then retry.
- **Dev or build says Box `cannot print the profile ... as JSON`.** The `box` on your `PATH` is
  older than the pinned release. Install the pinned release.
- **Box says `box's own packs were not found; set BOX_RESOURCES`.** A stale `BOX_RESOURCES` is set.
  Run `unset BOX_RESOURCES`, or open a new terminal.
- **Dev starts but model calls fail with `ExpiredTokenException`.** Your `[default]` credentials
  expired. Refresh them and restart dev.
- **Dev warns that the box profile `reads GITHUB_TOKEN for [egress.github], but it is not set`, and
  box then stops with `credential variable GITHUB_TOKEN is not set`.** Dev reads each `env://` key
  of the profile from the shell it runs in, then from `agentcore/.env.local`. Export it in that
  shell (`export GITHUB_TOKEN=...`), set it on the same line as dev, or put it in
  `agentcore/.env.local`, then restart dev. A variable set without `export` does not reach dev.
- **Dev on macOS fails with `sandbox initialization failed: Operation not permitted`.** Dev is
  running inside another sandbox. Run it from a normal terminal.
- **Build says Box is not installed or not on PATH.** Install `box` and put it on your `PATH`, then
  build again.
- **Build says Box refused the profile.** The lines under it are box's own error. A fresh checkout
  often has no agent venv yet, and box then names `.venv/bin/python` under a write grant. The error
  then says to run `uv sync` in the agent's folder (`app/<agent>`).
- **Build cannot download box.** The error names the release URL. Check your network; a 404 means
  the pinned version is not published in `strands-agents/box`.
- **`create` fails with `ENOENT while resolving package '@opentelemetry/core'`.** The CLI's
  dependencies are not installed, so `bun` fell back to its global cache. Run `bun install` in the
  CLI checkout (see "Install the CLI's dependencies").
- **Build says it cannot resolve credential "github" before its first deployment.** Expected when
  step 4's egress credential has never been deployed. Run `agentcore deploy` instead; it provisions
  the credential and builds. Standalone `build` works after that. See step 7.
- **Deploy says a credential has no secret.** The credential's value did not reach
  `agentcore/.env.local`. Export `GITHUB_TOKEN` and run build again, or set
  `AGENTCORE_CREDENTIAL_GITHUB` in the deploy environment.
- **The CDK app uses the published constructs, not yours.** Redo step 5. Confirm with
  `cat agentcore/cdk/node_modules/@aws/agentcore-cdk/package.json`.
