# {{name}}

This folder is the code for the `{{name}}` runtime. The AgentCore CLI created it
with `agentcore add runtime`. It doesn't contain any code yet. This README
explains what your code needs so that `agentcore dev` and `agentcore deploy`
work.

Using a coding agent? Point it at `AGENTS.md` in this folder. It has the same
requirements, written as instructions.

## What goes in this folder

```
app/{{name}}/
├── main.ts           # your entrypoint (required, this exact name)
├── package.json      # your dependencies (required)
├── tsconfig.json     # recommended, for your editor and type checking
├── node_modules/     # run `npm install`; deploy bundles from it
├── Dockerfile        # optional: only if you want a container build
└── ...               # any other modules main.ts imports
```

`main.ts` must sit at the root of this folder. The CLI always bundles from
`app/{{name}}/main.ts`, whatever else is in the folder. `agentcore.json` records
the bundled output, `main.js`, as the entrypoint.

## Direct code deploy or container?

The CLI decides when you run `dev`, `build`, or `deploy`:

- **No `Dockerfile` in this folder:** direct code deploy (CodeZip). The CLI
  bundles `main.ts` and everything it imports into a single `main.js` with
  esbuild, and AgentCore runs it on its managed Node.js runtime. This is the
  simpler option and the one we recommend.
- **A `Dockerfile` in this folder:** container deploy. The CLI builds your
  image and AgentCore runs it. See "Container builds" below.

## How `agentcore.json` follows your code

`agentcore add runtime` registered this runtime with starting values: a
direct code (CodeZip) build on Node.js {{versions.latestNode}} with entrypoint `main.js` (the
bundle the CLI builds from `main.ts`). Each time you run `agentcore dev`,
`agentcore build`, or `agentcore deploy`, the CLI reads your code, updates
the runtime in `agentcore/agentcore.json`, and prints anything it changed:

- **Build type:** adding a file named exactly `Dockerfile` to this folder
  switches the runtime to a container build, and the CLI says so. It never
  switches back on its own: to return to a direct code deploy, delete the
  Dockerfile and set `"build": "CodeZip"` in `agentcore.json`.
- **Node.js version** (CodeZip only): kept as long as `engines.node` in
  `package.json` allows it (see below).
- **Entrypoint** (CodeZip only): AgentCore currently bundles `main.ts` at the
  root of this folder, stored as `main.js`. A `"main"` of `"main.ts"` or
  `"main.js"` in `package.json` agrees with that; any other `"main"` is
  ignored with a warning.

## The runtime contract

AgentCore sends requests to a server your code runs. The easiest way to get
it right is the AgentCore SDK for TypeScript, `bedrock-agentcore`
(https://github.com/aws/bedrock-agentcore-sdk-typescript), which implements
the contract for you. For complete agents, see the samples at
https://github.com/awslabs/amazon-bedrock-agentcore-samples.

{{#if (eq protocol "HTTP")}}
For HTTP, the server listens on port **8080**, takes each invocation's JSON
payload on `POST /invocations` (returning JSON or a `text/event-stream`
stream), and answers health checks on `GET /ping` with
`{"status": "Healthy"}` (or `"HealthyBusy"` to keep a busy session alive).

```ts
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string().default('') }),
    async *process(payload, context) {
      // your agent logic here; yield chunks to stream
      yield { data: `You said: ${payload.prompt}` };
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
```

Read the port from `PORT`, so `agentcore dev` can move it if 8080 is busy.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
{{/if}}
{{#if (eq protocol "MCP")}}
For MCP, the server listens on port **8000** (read it from `PORT` in local
dev) and serves `POST /mcp` with the streamable HTTP transport. Stateless mode
is the default, and the server must accept the platform-provided
`Mcp-Session-Id` header. Stateful mode also works. It is required for
elicitation and sampling with MCP protocol version 2025-11-25 and earlier;
from 2026-07-28 those use multi-round-trip requests, which work in stateless
mode.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html
{{/if}}
{{#if (eq protocol "A2A")}}
For A2A, the server listens on port **9000** (read it from `PORT` in local
dev), takes JSON-RPC 2.0 messages (such as `message/send`) on `POST /`,
publishes its agent card at `GET /.well-known/agent-card.json`, and answers
health checks on `GET /ping`.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html
{{/if}}
{{#if (eq protocol "AGUI")}}
For AG-UI, the server listens on port **8080** (read it from `PORT` in local
dev), takes an AG-UI `RunAgentInput` on `POST /invocations` and streams AG-UI
events back as server-sent events, and answers health checks on `GET /ping`.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html
{{/if}}

Every protocol also shares these:

- AgentCore runs your code on **ARM64** Linux and expects it to listen on
  `0.0.0.0`.
- Each request carries an `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`
  header. Requests with the same session ID go to the same session (the same
  microVM), so you can keep per-conversation state in memory.
- Custom request headers only reach your code if they are named
  `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` and listed in
  `--request-header-allowlist` (`requestHeaderAllowlist` in `agentcore.json`).
- If you write your own `/ping`, don't set the optional `time_of_last_update`
  to the current time on every ping. Change it only when the status changes,
  or idle sessions never time out and can use up your session quota.

## Dependencies: `package.json`

```json
{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "main.ts",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc --noEmit",
    "dev": "tsx watch main.ts"
  },
  "dependencies": {
    "bedrock-agentcore": "~0.3.0",
    "zod": "~4.4.3"
  },
  "devDependencies": {
    "@types/node": "~22.0.0",
    "tsx": "~4.19.0",
    "typescript": "~5.6.0"
  }
}
```

- **`bedrock-agentcore`** provides the runtime server.
- **`tsx`** is what `agentcore dev` uses to run `main.ts` with reload on save.
- **Run `npm install` before you deploy.** The bundle is built from your
  local `node_modules`, and deploy fails if it's missing. `agentcore dev`
  runs `npm install` for you the first time.

### How your code is bundled

You don't need a build step. At deploy, esbuild bundles `main.ts` and every
import into one minified `main.js`. Only that file and a few packages the
SDK loads dynamically are uploaded. Your `node_modules` folder itself isn't.

Some consequences:

- **ESM source is fine.** Write normal `import`s, as in the example. The
  bundle is CommonJS, and esbuild converts your code.
- **No top-level `await` in `main.ts` or its imports.** CommonJS can't
  express it, so the bundle fails. Do async setup inside your handler, or in
  an async function you call from it.
- **`tsconfig.json` isn't read by the bundler.** Keep one for your editor
  and for `tsc --noEmit` type checking. `"module": "NodeNext"` with `.js`
  suffixes on relative imports works well.
- **Size.** The zip must be under 250 MiB.
- **Secrets.** Don't keep secrets in this folder. Use `agentcore/.env.local`
  for local secrets and a credential for deployed ones (see below).

### How the Node.js version is chosen

The Node.js version is `runtimeVersion` in `agentcore/agentcore.json`, and
the bundle targets it. A new runtime starts on the latest one AgentCore
supports (Node.js {{versions.latestNode}}; supported versions are {{versions.node}}).

`engines.node` is a constraint, not a choice. The CLI changes
`runtimeVersion` only when `engines.node` excludes the current version; it
then picks the **highest** supported version that `engines.node` allows,
writes it, and prints the change. For example, with the current version
Node.js {{versions.latestNode}}:

- `>=20` allows it, so nothing changes.
- `^20` excludes it, so the runtime moves to Node.js 20.

Nothing moves a runtime to a newer Node.js on its own, not even a newer CLI.
To move to a newer version, edit `runtimeVersion` (for example `"NODE_22"`)
or tighten `engines.node` so it excludes the old one.

## Using other resources

Resources you add to the project are passed to your runtime as environment
variables named after the resource:

- Memory (`agentcore add memory`): `MEMORY_<NAME>_ID` and `MEMORY_<NAME>_ARN`,
  where `<NAME>` is the memory name in upper case.
- Gateway (`agentcore add gateway`): `AGENTCORE_GATEWAY_<NAME>_URL`,
  `AGENTCORE_GATEWAY_<NAME>_ARN` and `AGENTCORE_GATEWAY_<NAME>_AUTH_TYPE`, where
  `<NAME>` is the gateway name in upper case with every character other than
  letters and digits turned into `_`.
- Credential (`agentcore add credential`): `CREDENTIAL_<NAME>_NAME`, the
  provider name (not the secret), where `<NAME>` is the credential name in
  upper case with `.` and `-` turned into `_`.

For example, a memory named `{{memoryExample.name}}` shows up as
`{{memoryExample.env}}`, a gateway named `{{gatewayExample.name}}` as
`{{gatewayExample.env}}`, and a credential named `{{credentialExample.name}}` as
`{{credentialExample.env}}`.

Read these from `process.env` and handle them being missing, so your code
still runs before the resource exists.

**API keys** (for example for a non-Bedrock model provider): add them with
`agentcore add credential`. The secret is never put in an environment
variable. Fetch it at runtime through AgentCore Identity with `withApiKey`
from `bedrock-agentcore`, using the provider name from
`CREDENTIAL_<NAME>_NAME`.

Your own variables go in `--environment-variables` (deployed) or
`agentcore/.env.local` (local only, gitignored).

## Run it locally

```bash
agentcore dev
```

`dev` runs `tsx watch main.ts` and sets:

- `PORT`: the port to listen on.
- `LOCAL_DEV=1`: for local-only behavior, such as reading an API key from
  `.env.local`.
- `AWS_REGION`.

## Deploy and invoke

```bash
agentcore deploy
agentcore invoke --runtime {{name}} --payload '{"prompt": "Hello"}'
```

## Observability

AgentCore doesn't auto-instrument Node.js runtimes the way it does Python.
To send traces, set up OpenTelemetry in your code.

## Container builds

Add a `Dockerfile` to this folder and the CLI switches to a container build.
Nothing else needs to change in `agentcore.json`.

Requirements for the image:

- **ARM64.** Images are built natively on ARM64 in AWS CodeBuild, so your
  base image has to support `linux/arm64`.
- **Port.** Listen on `0.0.0.0` on port {{port}} and `EXPOSE` it.
- **Non-root user.** Recommended: run as a non-root user.
- **Lockfile.** If you install with `npm ci`, commit `package-lock.json`.

A starting point:

```dockerfile
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx esbuild main.ts --bundle --platform=node --target=node22 --outfile=dist/main.js \
    && npm prune --omit=dev

USER node
EXPOSE {{port}}
CMD ["node", "dist/main.js"]
```

Notes:

- **No CLI bundling.** With a container build, the CLI doesn't bundle your
  code. The Dockerfile decides how it's built and started, and the
  Node.js version comes from your base image.
- **Build context.** The build context is this folder. Add a
  `.dockerignore` (at least `node_modules`). `.env` files are always left
  out.
- **Build arguments.** Set `customDockerBuildArgs` on this runtime in
  `agentcore.json` to pass build arguments.
- **Local engine.** `agentcore dev` builds and runs the image locally with
  Docker, Podman or Finch.
