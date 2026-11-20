# Local testing: a Box project with a workspace CLI and L3 constructs

This guide creates, builds, and deploys a Box project with the AgentCore CLI and the
`@aws/agentcore-cdk` L3 constructs taken from your local workspace, not the published
packages. Use it to test the Box gateway, its egress targets, and API key credentials
end to end before you publish.

A "Box project" (`"projectType": "box"` in `agentcore.json`) runs its agent in a _box_:
a sandbox that controls the agent's network egress and filesystem access. Each runtime
gets its own Box gateway, named after the runtime: the runtime `agent` gets `agent-box`.

## Where box comes from

A Box project ships box inside its deploy artifact, so the agent runs in a box on AgentCore
Runtime. Each box runtime names its box release in `agentcore.json` with
`"box": { "version": "<version>" }`, which `agentcore create` writes. `agentcore build` and
`agentcore deploy` download that release's Linux build from
[mquang-amazon/box-releases](https://github.com/mquang-amazon/box-releases) once into
`~/.agentcore/box/`, check its SHA-256s, generate it into the agent's `.box/<runtime>/aws/`, and copy
that into the zip or the image's `.box-dist/`.
A container image downloads the Linux build while it builds, under `agentcore dev` too. For a
CodeZip agent, `agentcore dev` runs the `box` on your PATH: install it as in
[Install box](#install-box). No local box checkout is needed.

To try an unreleased box build, publish it as a pre-release with the same file names and set
`box.version` to it: a version the CLI does not pin takes its checksums from the release's
`SHA256SUMS.txt`.

## Prerequisites

- A local checkout of the CLI and of `@aws/agentcore-cdk`.
- `box` `0.1.11-mquang.preview.9` on your `PATH`, the release the CLI pins. The oldest box that
  works is `0.1.11-linux-preview.7`, the first release with
  [strands-agents/staging-boxy#625](https://github.com/strands-agents/staging-boxy/pull/625), which
  the default telemetry target of the AgentCore Runtime profile needs. Build, deploy and dev run it
  to read the box profile with `box profile show --format json --full`, and CodeZip dev runs the
  agent with it. See [Install box](#install-box).
- AWS credentials for a **dev or test** account. Build writes the Box gateway's Bedrock and
  Memory targets for `AWS_REGION` (else your AWS profile's region), and deploy for its target's
  region.
- `bun` for the CLI, `npm` for the generated CDK app.

## Install box

box ships as a release archive per machine on
[mquang-amazon/box-releases](https://github.com/mquang-amazon/box-releases). There are builds for
macOS on an Apple chip (`aarch64-apple-darwin`) and Linux arm64 (`aarch64-unknown-linux-gnu`); there
is no x86 build yet. Each archive unpacks flat: `box`, its two helpers, `release.json`, and
`resources/` (box's packs, which it finds beside itself).

Download the archive for your machine, check it, and unpack it into a versioned folder.

macOS on an Apple chip:

```
mkdir -p ~/.local/share/box/0.1.11-mquang.preview.9 && cd ~/.local/share/box/0.1.11-mquang.preview.9
curl -fSLO https://github.com/mquang-amazon/box-releases/releases/download/v0.1.11-mquang.preview.9/box-v0.1.11-mquang.preview.9-aarch64-apple-darwin.tar.gz
curl -fSLO https://github.com/mquang-amazon/box-releases/releases/download/v0.1.11-mquang.preview.9/SHA256SUMS.txt
grep aarch64-apple-darwin SHA256SUMS.txt | shasum -a 256 -c -
tar -xzf box-v0.1.11-mquang.preview.9-aarch64-apple-darwin.tar.gz
```

Linux arm64:

```
mkdir -p ~/.local/share/box/0.1.11-mquang.preview.9 && cd ~/.local/share/box/0.1.11-mquang.preview.9
curl -fSLO https://github.com/mquang-amazon/box-releases/releases/download/v0.1.11-mquang.preview.9/box-v0.1.11-mquang.preview.9-aarch64-unknown-linux-gnu.tar.gz
curl -fSLO https://github.com/mquang-amazon/box-releases/releases/download/v0.1.11-mquang.preview.9/SHA256SUMS.txt
grep aarch64-unknown-linux-gnu SHA256SUMS.txt | sha256sum -c -
tar -xzf box-v0.1.11-mquang.preview.9-aarch64-unknown-linux-gnu.tar.gz
```

The check must print `OK`.

Put the folder first on your `PATH`, for this shell and for new ones (use `~/.bashrc` for bash):

```
export PATH="$HOME/.local/share/box/0.1.11-mquang.preview.9:$PATH"
grep -q 'share/box/0.1.11-mquang.preview.9' ~/.zshrc || echo 'export PATH="$HOME/.local/share/box/0.1.11-mquang.preview.9:$PATH"' >> ~/.zshrc
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
- `box --version` must print `box 0.1.11-mquang.preview.9`, the release the CLI pins in
  `src/core/project/backends/boxRelease.json`. The oldest box that build, deploy and dev accept is
  `0.1.11-linux-preview.7`.
- On macOS, if Gatekeeper refuses to run `box`, clear the download flag with
  `xattr -dr com.apple.quarantine "$HOME/.local/share/box/0.1.11-mquang.preview.9"`.

To move to a newer release, unpack it into its own folder the same way and change the `PATH` line
to that folder.

## Settings

Set these once per shell. Change the values for your machine: `CLI` is the CLI run from source in
your workspace checkout, `L3` is the local L3 constructs checkout, and `DEMO` and `PROJECT` say
where the demo project goes. Use absolute paths: the steps below `cd` into other folders, where a
relative path no longer resolves (`bun` then says `Module not found "./agentcore-cli/src/index.ts"`).
Replace `/path/to/workspace` with the folder that holds both checkouts:

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

Build and deploy run `box profile show .box/<runtime>/local/profile.toml --format json --full` in
the project folder, with the `box` on your `PATH`, and turn the `box.toml` and `policy.dw` that Box
resolves the profile to into the runtime's Box network. Every pack, option, and rule Box adds is
already in them, so any pack works. They change nothing in `.box/<runtime>/local/`; they generate
the Runtime profile and its resources under `.box/<runtime>/aws/`.

Box `0.1.11-linux-preview.7` names its packs `@box/base`, `@box/bedrock`, and `@box/agentcore`.
For a profile that names a pack or a plugin `box/<name>`, build stops and gives each `@box/<name>`
name.

- **Gateway targets.** Each host or `host:port` that an `[egress]` entry, an `[mcp]` server
  with `type = "http"`, or a policy permit names, and that the policy allows at least one
  request to, gets one passthrough target on `<runtime>-box`. The target of an MCP server is
  `egress-<server>`. Its `protocolType` is `CUSTOM`, thus only Box makes the decision on each
  `mcp:call`. A host the gateway already has a target for keeps that target. Build owns
  only the targets whose name starts with `egress-`: it adds them, changes them, and removes
  one when no host needs it. It never changes another target.
- **Outbound auth.** An `aws://` secret signs with the gateway's role, an `env://` secret
  sends an API key from AgentCore Identity, and an entry with no secret sends no credential.
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
  the gateway's `additionalPolicies` that is missing or is not JSON, as it counts none of its
  actions.
- **The AgentCore Runtime profile.** The generated `.box/<runtime>/aws/profile.toml` (copied into
  `.box-dist/`) has one `[egress.<target>]` route through the gateway for each target of
  `<runtime>-box`. For the target of an MCP server, the profile has an `[mcp.<server>]` server
  through the gateway, not an `[egress]` route. That server keeps its `env://` secret, thus the
  agent keeps its stand-in key. Each policy file is copied beside it, byte for byte, and listed under `policies`.
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

## 6. Test locally with `agentcore dev`

`agentcore dev` runs the agent in a box on your machine, so you can try the project before you
deploy. It deploys nothing. The agent signs its Bedrock calls with your `[default]` AWS profile
(`secret.ref = "aws://default"` in `.box/agent/local/profile.toml`), and Memory is off
(`LOCAL_DEV=1`).

Dev runs an agent in a box only in a Box project, as build and deploy do: `agentcore.json` must
have `"projectType": "box"`, which `create` writes for the box templates. Without it, dev runs a
plain runtime the usual way, and stops on one that starts box (a CodeZip `start.py` entrypoint, or
a Dockerfile that installs box) with `agentcore.json has no "projectType": "box"`.

### Which box builds exist

The box release has these builds:

| Machine             | Build                                      | CodeZip dev | Container dev |
| ------------------- | ------------------------------------------ | ----------- | ------------- |
| macOS, Apple chip   | `box-v<version>-aarch64-apple-darwin`      | yes         | yes           |
| Linux, arm64        | `box-v<version>-aarch64-unknown-linux-gnu` | yes         | yes           |
| Linux or macOS, x86 | none                                       | no          | no            |

- The **container** image always uses the Linux arm64 build, because AgentCore Runtime is arm64.
  It runs on an Apple chip Mac through Finch or Docker, and on an arm64 Linux host. An x86 host
  would need to emulate arm64.
- **CodeZip** dev runs the `box` on your `PATH` natively, so it needs the build for your machine.
  On an arm64 Linux host it uses the same Linux build as the Runtime.
- Build and deploy need a `box` on your `PATH` on every machine, to read the profile. So for now
  build and deploy work only on an Apple chip Mac or an arm64 Linux host.

### Before you start

In the shell you run dev from:

```
box --version
aws sts get-caller-identity
```

- `box --version` must print `0.1.11-linux-preview.7` or later. Dev and build read the profile with
  `box profile show --format json --full`. The AgentCore Runtime profile signs each Box gateway
  backend for `${{ inputs.aws.region }}`, and its default telemetry target reads one key of
  `OTEL_EXPORTER_OTLP_LOGS_HEADERS`. A box release before it cannot do all of these.
- The `[default]` profile must hold fresh credentials, because box reads them when dev starts.
  After you refresh them, restart dev.

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
when the shell has none. If neither has it, dev warns, naming the variable and how to set it, and box
then refuses to start (`credential variable GITHUB_TOKEN is not set`). A variable set without
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

- Dev runs `box run .box/<runtime>/local/profile.toml` in the project folder with the `box` on
  your `PATH`. The box listens on 8080 and relays to the agent on 8081.
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
- The dev output shows box starting the agent: `box: running profile cliDemo` (your `$PROJECT`) and the
  `[agent]` filesystem summary, with `deny_write  .../.venv  (read-only)` for CodeZip.
- With the step 4 `[egress]` entry, calls to its host go out, and calls to other hosts are blocked
  (`ProxyConnectionError ... 127.0.0.1:<port>` in the agent's log means box blocked the host).

Stop dev with Ctrl+C before you build.

## 7. Build

Export `GITHUB_TOKEN` before build. Build reads it and writes its value into
`agentcore/.env.local` under the credential's reserved name `AGENTCORE_CREDENTIAL_GITHUB`.
Build does this on **every** run, so you set only the one variable the box already uses.

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
skip straight to step 8: `deploy` provisions the credential and then builds in one step (keep
`GITHUB_TOKEN` exported). After that first deploy, `build` runs standalone as above.

## 8. Deploy

```
bun run "$CLI" deploy
```

Deploy synthesizes the CDK app you linked in step 5, so the stack uses your local L3 constructs.
The first deploy makes the `default` target from your account and region.

## 9. Verify the gateway, its targets, and the credential

Local checks, in `agentcore/agentcore.json`:

- `"projectType": "box"`.
- A gateway named `agent-box` with a `bedrock` passthrough target in the deploy region, and an
  `egress-github` target for `https://api.github.com`.
- A credential named `github` with `authorizerType: ApiKeyCredentialProvider`.

Live checks, after deploy. Deploy names each AWS resource after the project and the deploy target
(`default`), so the names differ from those in `agentcore.json`:

- The Box gateway `agent-box` deploys as `<project>-default-agent-box`, for example
  `cliDemo-default-agent-box`. Its ID is that name in lowercase with a suffix, for example
  `clidemo-default-agent-box-njdu1hh4uy`, and is a stack output.
- The credential `github` deploys as the API key credential provider `<project>_default_github`,
  for example `cliDemo_default_github`.

```
GATEWAY_ID=$(aws cloudformation describe-stacks --stack-name "AgentCore-$PROJECT-default" --query "Stacks[0].Outputs[?starts_with(OutputKey, 'ApplicationGatewayAgentBoxIdOutput')].OutputValue" --output text)
echo "$GATEWAY_ID"
bun run "$CLI" gateway get --id "$GATEWAY_ID"
bun run "$CLI" identity api-key-credential-provider get --name "${PROJECT}_default_github"
```

`gateway list` shows every gateway in the account and region, not only this project's, so look
the Box gateway up by its ID as above.

## 10. Read box telemetry and gateway logs in CloudWatch

On AgentCore Runtime, box sends each policy decision (permit, deny, trace) to the log group of the
Runtime, `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`, stream `otel-rt-logs`. When the box
profile of the agent has no `cloudwatch_logs` target, build adds the target `[telemetry.agentcore]`
to the Runtime profile. If the profile has a target with the name `agentcore`, the name is
`[telemetry.agentcore_default]`. When the run starts, box fills the region of the target from
`AWS_REGION`, and its log group and stream from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`. The target sends
the deny, permit, and trace records, and box signs it with the execution role.

The CLI and the L3 constructs make no log group for box. The role that the CDK makes for the
runtime can write to the log group of the Runtime, thus build adds no grant for it. A runtime that
names an `executionRoleArn` must have `logs:CreateLogStream` and `logs:PutLogEvents` on
`/aws/bedrock-agentcore/runtimes/*`.

The `logs runtime` command finds that log group from the runtime name:

```sh
cd "$DEMO/$PROJECT"
bun run "$CLI" logs runtime --name agent --since 15m --query '"strands.box.policy.verdict"'
```

Each record is one decision, with `strands.box.policy.verdict`, `.rule`, and `.resource`. To show
only the deny decisions, use `--query '"deny"'`.

Deploy always sends the `APPLICATION_LOGS` of each Box gateway to
`/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<gateway ID>`. The gateway sends no
traces to X-Ray. Read the gateway logs with the gateway ID from step 9:

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
   `xray:PutSpans` and `xray:PutTraceSegments` for a `cloudwatch_traces` target. With
   `AGENTCORE_BOX_SECRETS_MANAGER=1`, deploy keeps the key of each third-party target (`otlp`,
   `langfuse`, or `langsmith`) in the AWS Secrets Manager secret
   `agentcore/<project>/<runtime>/box`. The file then also gives the role
   `secretsmanager:GetSecretValue` on that secret.

4. Invoke the agent, then read the records:

   ```sh
   bun run "$CLI" invoke --runtime agent --payload '{"prompt":"What is 17 times 23?"}'
   aws logs tail "/aws/box/$PROJECT" --region "$REGION" --since 15m
   ```

   To show only the deny decisions, add `--filter-pattern '"deny"'`.

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

- **Dev says `'box' was not found on your PATH`.** Download the build for your machine from the
  box release, unpack it into a folder, add that folder to your `PATH`, then retry.
- **Dev or build says Box `cannot print the profile ... as JSON`.** The `box` on your `PATH` is
  older than `0.1.11-linux-preview.7`. Install that release or later.
- **Box says `box's own packs were not found; set BOX_RESOURCES`.** A stale `BOX_RESOURCES` is
  set. Run `unset BOX_RESOURCES`, or open a new terminal.
- **Dev starts but model calls fail with `ExpiredTokenException`.** Your `[default]` credentials
  expired. Refresh them and restart dev.
- **Dev warns that the box profile `reads GITHUB_TOKEN for [egress.github], but it is not set`, and
  box then stops with `credential variable GITHUB_TOKEN is not set`.** Dev reads each `env://` key
  of the profile from the shell it runs in, then from `agentcore/.env.local`. Export it in that
  shell (`export GITHUB_TOKEN=...`), set it on the same line as dev, or put it in
  `agentcore/.env.local`, then restart dev. A variable set without `export` does not reach dev.
- **Dev on macOS fails with `sandbox initialization failed: Operation not permitted`.** Dev is
  running inside another sandbox. Run it from a normal terminal.
- **Build says Box is not installed or not on PATH.** Install `box` and put it on your `PATH`,
  then build again.
- **Build says Box refused the profile.** The lines under it are box's own error. A fresh
  checkout often has no agent venv yet, and box then names `.venv/bin/python` under a write
  grant. The error then says to run `uv sync` in the agent's folder (`app/<agent>`).
- **Build cannot download box.** The error names the release URL. Check your network; a 404
  means the pinned version is not published in `mquang-amazon/box-releases`.
- **`create` fails with `ENOENT while resolving package '@opentelemetry/core'`.** The CLI's
  dependencies are not installed, so `bun` fell back to its global cache. Run `bun install` in
  the CLI checkout (see "Install the CLI's dependencies").
- **Build says it cannot resolve credential "github" before its first deployment.** Expected
  when step 4's egress credential has never been deployed. Run `agentcore deploy` instead; it
  provisions the credential and builds. Standalone `build` works after that. See step 7.
- **Deploy says a credential has no secret.** The credential's value did not reach
  `agentcore/.env.local`. Export `GITHUB_TOKEN` and run build again, or set
  `AGENTCORE_CREDENTIAL_GITHUB` in the deploy environment.
- **The CDK app uses the published constructs, not yours.** Redo step 5. Confirm with
  `cat agentcore/cdk/node_modules/@aws/agentcore-cdk/package.json`.
