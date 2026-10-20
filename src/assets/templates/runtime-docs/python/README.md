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
├── main.py           # your entrypoint (required; see [tool.agentcore] to rename)
├── pyproject.toml    # your dependencies (required)
├── Dockerfile        # optional: only if you want a container build
└── ...               # any other modules your code imports
```

The entrypoint is `main.py` at the root of this folder unless you name another
file in `pyproject.toml` (see "How `agentcore.json` follows your code"). Other
modules can live anywhere inside it and be imported normally.

## Direct code deploy or container?

The CLI decides when you run `dev`, `build`, or `deploy`:

- **No `Dockerfile` in this folder:** direct code deploy (CodeZip). The CLI
  installs your dependencies with uv, zips them with your code, and AgentCore
  runs `main.py` on its managed Python runtime. This is the simpler option
  and the one we recommend unless you need system packages or full control
  of the image.
- **A `Dockerfile` in this folder:** container deploy. The CLI builds your
  image and AgentCore runs it. See "Container builds" below.

## How `agentcore.json` follows your code

`agentcore add runtime` registered this runtime with starting values: a
direct code (CodeZip) build on Python {{versions.latestPython}} with entrypoint `main.py`. Each
time you run `agentcore dev`, `agentcore build`, or `agentcore deploy`, the
CLI reads your code, updates the runtime in `agentcore/agentcore.json`, and
prints anything it changed:

- **Build type:** adding a file named exactly `Dockerfile` to this folder
  switches the runtime to a container build, and the CLI says so. It never
  switches back on its own. To return to a direct code deploy, delete the
  `Dockerfile`, then open `agentcore/agentcore.json`. In the `runtimes` array,
  find the object whose `"name"` is `"{{name}}"`, set `"build": "CodeZip"`,
  remove `"dockerfile"` (and `"buildContextPath"` or
  `"customDockerBuildArgs"` if present), and add
  `"runtimeVersion": "{{versions.latestPythonRuntime}}"` to that same object.
  The CLI removed `runtimeVersion` when it switched to a container build, and
  CodeZip requires it.
- **Python version** (CodeZip only): kept as long as `requires-python` in
  `pyproject.toml` allows it (see below).
- **Entrypoint:** from `[tool.agentcore]` in `pyproject.toml`, if you want a
  file other than `main.py`, or an app object other than `app`. The CLI reads
  exactly this form, a `[tool.agentcore]` table with `entrypoint = "..."` on
  one line:

  ```toml
  [tool.agentcore]
  entrypoint = "main.py"   # or "server.py:app"
  ```

Where your code doesn't say (no `[tool.agentcore]`), the value already in
`agentcore.json` is kept.

## The runtime contract

AgentCore sends requests to a server your code runs. The easiest way to get
it right is the AgentCore SDK for Python, `bedrock-agentcore`
(https://github.com/aws/bedrock-agentcore-sdk-python), which implements the
contract for you. For complete agents built on it, see the samples at
https://github.com/awslabs/amazon-bedrock-agentcore-samples.

{{#if (eq protocol "HTTP")}}
For HTTP, the server listens on port **8080**, takes each invocation's JSON
payload on `POST /invocations` (returning JSON or a `text/event-stream`
stream), and answers health checks on `GET /ping` with
`{"status": "Healthy"}` (or `"HealthyBusy"` to keep a busy session alive).

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    prompt = payload.get("prompt", "")
    # your agent logic here
    return {"message": f"You said: {prompt}"}


if __name__ == "__main__":
    app.run()
```

Keep the module-level `app` (`agentcore dev` serves it with uvicorn and
reloads it when you save) and the `app.run()` at the end (deployed, AgentCore
runs `main.py` directly, so it must start the server itself).
`context.session_id` identifies the conversation.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
{{/if}}
{{#if (eq protocol "MCP")}}
For MCP, the server listens on port **8000** and serves `POST /mcp` with the
streamable HTTP transport. Stateless mode (`stateless_http=True`) is the
default, and the server must accept the platform-provided `Mcp-Session-Id`
header. Stateful mode also works. It is required for elicitation and sampling
with MCP protocol version 2025-11-25 and earlier; from 2026-07-28 those use
multi-round-trip requests, which work in stateless mode.

```python
import os
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "{{name}}",
    host="0.0.0.0",
    port=int(os.environ.get("FASTMCP_PORT", "8000")),
    stateless_http=True,
)


@mcp.tool()
def add_numbers(a: int, b: int) -> int:
    """Add two numbers together"""
    return a + b


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

Add `mcp` to your dependencies. Read `FASTMCP_PORT` as above so
`agentcore dev` can move the server when port 8000 is busy.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html
{{/if}}
{{#if (eq protocol "A2A")}}
For A2A, the server listens on port **9000**, takes JSON-RPC 2.0 messages
(such as `message/send`) on `POST /`, publishes its agent card at
`GET /.well-known/agent-card.json`, and answers `GET /ping`. `serve_a2a`
from the SDK does all three:

```python
from bedrock_agentcore.runtime import serve_a2a

# executor: any a2a-sdk AgentExecutor, e.g. StrandsA2AExecutor
if __name__ == "__main__":
    serve_a2a(executor)
```

Add `bedrock-agentcore[a2a] ~= 1.24.0` (the version line with `serve_a2a`) and
`a2a-sdk` to your dependencies, as in the `pyproject.toml` example below.
`agentcore dev` sets `A2A_PORT` when it needs a local port other than the
deployed service-contract default of 9000; `serve_a2a` reads it automatically.

Full contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html
{{/if}}
{{#if (eq protocol "AGUI")}}
For AG-UI, the server listens on port **8080**, takes an AG-UI
`RunAgentInput` on `POST /invocations` and streams AG-UI events back as
server-sent events, and answers health checks on `GET /ping`. Read the port
from `PORT` so `agentcore dev` can move it:

```python
import os
import uvicorn
from fastapi import FastAPI

app = FastAPI()
# mount your AG-UI endpoint at /invocations and a health check at /ping

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
```

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

## Dependencies: `pyproject.toml`

Declare dependencies in `[project].dependencies`. That's the only place the
CLI reads them from. For direct code deploy, `requirements.txt` and
`uv.lock` are ignored.

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "{{name}}"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
{{#if (eq protocol "A2A")}}
    "bedrock-agentcore[a2a] ~= 1.24.0",
    "a2a-sdk[all] ~= 0.3.26",
{{else}}
    "bedrock-agentcore >= 1.18.1, < 2.0.0",
{{/if}}
    "aws-opentelemetry-distro ~= 0.21.0",
    # your framework and libraries, e.g. "strands-agents >= 1.15.0, < 2.0.0"
]

[tool.hatch.build.targets.wheel]
packages = ["."]
```

Two dependencies are required:

- **`bedrock-agentcore`** provides the runtime server for HTTP and A2A.
- **`aws-opentelemetry-distro`** is needed because AgentCore starts your code
  with `opentelemetry-instrument`. Without it, the runtime won't start.
  You'll also get traces and logs in CloudWatch.

You need [uv](https://docs.astral.sh/uv/) installed. `agentcore dev` runs
your code with `uv run`, and `agentcore deploy` uses uv to install your
dependencies. Run `uv sync` once after editing `pyproject.toml` to get a
local `.venv`.

### How the Python version is chosen

The Python version is `runtimeVersion` in `agentcore/agentcore.json`. A new
runtime starts on the latest one AgentCore supports (Python
{{versions.latestPython}}; supported versions are {{versions.python}}).

`requires-python` is a constraint, not a choice. The CLI changes
`runtimeVersion` only when `requires-python` excludes the current version;
it then picks the **highest** supported version that `requires-python`
allows, writes it, and prints the change. For example, with the current
version Python {{versions.latestPython}}:

- `>=3.12` allows it, so nothing changes.
- `>=3.10,<3.13` excludes it, so the runtime moves to Python 3.12.
- `==3.11.*` excludes it, so the runtime moves to Python 3.11.

Nothing moves a runtime to a newer Python on its own, not even a newer CLI.
To move to a newer version, edit `runtimeVersion` (for example
`"PYTHON_3_13"`) or tighten `requires-python` so it excludes the old one.

### Things that break direct code deploys

- **Packages without ARM64 Linux wheels.** AgentCore runs on ARM64 Linux,
  and the CLI only installs prebuilt wheels (`aarch64-manylinux`, glibc 2.34
  or older). Packages that only publish source distributions fail to
  install. If you need one, use a container build.
- **Size.** The zip, meaning your code plus installed dependencies, must be
  under 250 MiB.
- **Secrets.** Everything in this folder is uploaded, including `.env`
  files. Only `.git`, `.venv`, `__pycache__`, `.pytest_cache`,
  `node_modules` and `.DS_Store` are left out. Put local secrets in
  `agentcore/.env.local` instead. Put deployed secrets in a credential (see
  below).

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

An MCP Gateway's URL is already its complete MCP endpoint. A Gateway with
`protocolType: "None"` provides a bare origin instead: append `/mcp` when
using its MCP interface, or append the route required by the HTTP target.

For example, a memory named `{{memoryExample.name}}` shows up as
`{{memoryExample.env}}`, a gateway named `{{gatewayExample.name}}` as
`{{gatewayExample.env}}`, and a credential named `{{credentialExample.name}}` as
`{{credentialExample.env}}`. Read these with
`os.environ.get(...)` and handle them being missing, so your code still runs before the resource
exists.

**API keys** (for example for a non-Bedrock model provider): add them with
`agentcore add credential`. The secret is never put in an environment
variable. Fetch it at runtime through AgentCore Identity with the
`@requires_api_key(provider_name=...)` decorator from `bedrock_agentcore`,
using the provider name from `CREDENTIAL_<NAME>_NAME`.

Your own variables go in `--environment-variables` (deployed) or
`agentcore/.env.local` (local only, gitignored).

## Run it locally

```bash
agentcore dev
```

`dev` sets a few variables for you:

- `PORT`: the port to listen on.
- `LOCAL_DEV=1`: use this if your code should behave differently locally,
  for example reading an API key from `.env.local` instead of AgentCore
  Identity.
- `AWS_REGION`.

It also starts a local OpenTelemetry collector, so you can see traces while
you develop.

## Deploy and invoke

```bash
agentcore deploy
agentcore invoke --runtime {{name}} --payload '{"prompt": "Hello"}'
```

## Container builds

Add a `Dockerfile` to this folder and the CLI switches to a container build.
Nothing else needs to change in `agentcore.json`.

Requirements for the image:

- **ARM64.** Images are built natively on ARM64 in AWS CodeBuild, so your
  base image has to support `linux/arm64`. Most official images do.
- **Port.** Listen on `0.0.0.0` on port {{port}} and `EXPOSE` it.
- **Non-root user.** Recommended: run as a non-root user (for example
  uid 1000).
- **Observability.** Start your app with `opentelemetry-instrument` to get
  traces and logs in CloudWatch.
- **Lockfile.** If you install with `uv sync --frozen`, commit `uv.lock`.
  Run `uv lock` to create it.

A starting point:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.12-slim-trixie

RUN pip install --no-cache-dir uv
ARG UV_DEFAULT_INDEX
ARG UV_INDEX
ENV UV_SYSTEM_PYTHON=1 UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1 \
    UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX} UV_INDEX=${UV_INDEX} \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app
RUN useradd -m -u 1000 bedrock_agentcore

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --chown=bedrock_agentcore:bedrock_agentcore . .
RUN uv sync --frozen --no-dev

USER bedrock_agentcore
EXPOSE {{port}}
CMD ["opentelemetry-instrument", "python", "-m", "main"]
```

Notes:

- **Build context.** The build context is this folder. Add a
  `.dockerignore` to keep things out of it. `.env` files are always left
  out.
- **Build arguments.** To pass build arguments, such as a private package
  index for `UV_DEFAULT_INDEX`, set `customDockerBuildArgs` on this runtime
  in `agentcore.json`.
- **Local engine.** `agentcore dev` builds and runs the image locally with
  Docker, Podman or Finch, so you need one of them installed.
- **Python version.** For container builds, the Python version is whatever
  your base image provides. `requires-python` isn't used.
