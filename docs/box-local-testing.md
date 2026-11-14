# Local testing: a Box project with a workspace CLI and L3 constructs

This guide creates, builds, and deploys a Box project with the AgentCore CLI and the
`@aws/agentcore-cdk` L3 constructs taken from your local workspace, not the published
packages. Use it to test the Box gateway, its policy engine, and API key credentials
end to end before you publish.

A "Box project" (`"projectType": "box"` in `agentcore.json`) runs its agent in a _box_:
a sandbox that controls the agent's network egress and filesystem access. Each runtime
gets its own Box gateway (`<runtime>-box`) and a dedicated policy engine (`<runtime>_box`).

## What `AGENTCORE_BOX_SOURCE` means

`AGENTCORE_BOX_SOURCE` is an environment variable that points `agentcore build` at a local
checkout of **box** (the sandbox runtime) that holds the **Amazon Linux 2023** build of the
box binaries. A Box project ships box inside its deploy artifact, so the agent runs in a box
on AgentCore Runtime. Build copies the binaries from this checkout into the zip.

The checkout must hold:

- `target-al2023/release/box`
- `target-al2023/release/strands-box-sock-alias`
- `target-al2023/release/strands-box-contain-trampoline`
- `target-al2023/ffi` (the `_ctypes` and `libffi` that the box allows)
- `resources/` (the box packs)

Build the box binaries for Amazon Linux 2023 into that folder first. If the variable is unset,
or the folder does not hold these files, a Box project build fails with a message that names
the missing path.

## Prerequisites

- A local checkout of the CLI and of `@aws/agentcore-cdk`.
- A box checkout for `AGENTCORE_BOX_SOURCE`, built for Amazon Linux 2023 (see above).
- AWS credentials for a **dev or test** account. Box uses `us-west-2` Bedrock.
- `bun` for the CLI, `npm` for the generated CDK app.

## Settings

Set these once per shell. Change the values for your machine.

```
# The CLI, run from source. Point at your workspace checkout.
CLI=/path/to/workspace/agentcore-cli/src/index.ts

# The local L3 constructs checkout.
L3=/path/to/workspace/agentcore-l3-cdk-constructs

# The box checkout with the Amazon Linux 2023 binaries.
export AGENTCORE_BOX_SOURCE=/path/to/box

# Where the demo project goes.
DEMO=/tmp/cliDemo
PROJECT=cliDemo
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
bun run "$CLI" create --name "$PROJECT" --template agent-python-strands
```

## 4. (Optional) add an egress credential to test

This adds a `github` API key credential. Build declares the credential from the `env://`
route, and deploy provisions it in AgentCore Identity.

```
printf '\n[egress.github]\nsecret.ref = "env://GITHUB_TOKEN"\n' >> "$DEMO/$PROJECT/.box/profile.toml"
```

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
Build does this on **every** run, so you set only the one variable the box already uses.

```
cd "$DEMO/$PROJECT"
export GITHUB_TOKEN=ghp_demo_value
bun run "$CLI" build
grep AGENTCORE_CREDENTIAL_GITHUB agentcore/.env.local
```

## 7. Deploy

```
bun run "$CLI" deploy
```

Deploy synthesizes the CDK app you linked in step 5, so the stack uses your local L3 constructs.
The first deploy makes the `default` target from your account and region.

## 8. Verify the gateway, policy engine, and credential

Local checks, in `agentcore/agentcore.json`:

- `"projectType": "box"`.
- A gateway named `agent-box` with a `bedrock` passthrough target in `us-west-2`.
- A policy engine named `agent_box`, attached to `agent-box` in `ENFORCE` mode.
- A credential named `github` with `authorizerType: ApiKeyCredentialProvider`.

Live checks, after deploy:

```
bun run "$CLI" gateway list
bun run "$CLI" identity api-key-credential-provider get --name github
```

The policy engine guard keeps a Box gateway's own engine. This keeps it and prints a notice:

```
bun run "$CLI" remove policy-engine --name agent_box
```

## 9. Tear down

Deploy bills you while resources exist. Remove them when done.

```
bun run "$CLI" remove all --yes
bun run "$CLI" deploy
```

## Troubleshooting

- **Build cannot find the box binaries.** `AGENTCORE_BOX_SOURCE` is unset or does not hold
  `target-al2023/release`. Build box for Amazon Linux 2023 in that checkout first.
- **Deploy says a credential has no secret.** The credential's value did not reach
  `agentcore/.env.local`. Export `GITHUB_TOKEN` and run build again, or set
  `AGENTCORE_CREDENTIAL_GITHUB` in the deploy environment.
- **The CDK app uses the published constructs, not yours.** Redo step 5. Confirm with
  `cat agentcore/cdk/node_modules/@aws/agentcore-cdk/package.json`.
