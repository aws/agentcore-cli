# Container Builds

Container builds package your agent as a Docker container image instead of a code ZIP. Use containers when you need
system-level dependencies, custom native libraries, or full control over the runtime environment.

## Prerequisites

A container runtime is required for local development (`agentcore dev`) and packaging (`agentcore package`). Supported
runtimes:

1. [Docker](https://docker.com)
2. [Podman](https://podman.io)
3. [Finch](https://runfinch.com)

The CLI auto-detects the first working runtime in the order listed above. If multiple are installed, the
highest-priority one wins.

> A local runtime is **not** required for `agentcore deploy` — AWS CodeBuild builds the image remotely.

## Getting Started

```bash
# New project with container build
agentcore create --name MyProject --build Container

# Add container agent to existing project
agentcore add agent --name MyAgent --build Container --framework Strands --model-provider Bedrock
```

Both commands generate a `Dockerfile` and `.dockerignore` in the agent's code directory:

```
app/MyAgent/
├── Dockerfile
├── .dockerignore
├── pyproject.toml
└── main.py
```

## Generated Dockerfile

The template uses `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` as the base image with these design choices:

- **Layer caching**: Dependencies (`pyproject.toml`) are installed before copying application code
- **Non-root**: Runs as `bedrock_agentcore` (UID 1000)
- **Observability**: Default CMD wraps the agent with `opentelemetry-instrument`
- **Fast installs**: Uses `uv pip install` for dependency resolution

You can customize the Dockerfile freely — add system packages, change the base image, or use multi-stage builds.

## Configuration

In `agentcore.json`, set `"build": "Container"`:

```json
{
  "name": "MyAgent",
  "build": "Container",
  "entrypoint": "main.py",
  "codeLocation": "app/MyAgent/",
  "runtimeVersion": "PYTHON_3_14"
}
```

All other fields work the same as CodeZip agents.

> **Converting an existing CodeZip agent?** Changing the `build` field in `agentcore.json` alone is not enough — you
> must also add a `Dockerfile` and `.dockerignore` to the agent's code directory. The easiest way is to create a
> throwaway container agent with `agentcore add agent --build Container` and copy the generated files.

### Advanced: Shared Dockerfile (monorepo)

When multiple agents share the same build logic, you can point them all at a single `Dockerfile` using two optional
fields:

| Field                   | Description                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `buildContextPath`      | Docker build context directory. Replaces `codeLocation` as the positional `docker build` argument.  |
| `customDockerBuildArgs` | Key/value pairs forwarded as `--build-arg` flags, allowing a shared Dockerfile to branch per agent. |

**Example — two agents, one Dockerfile at the project root:**

```json
{
  "name": "agent-one",
  "build": "Container",
  "entrypoint": "main.py",
  "codeLocation": "app/agent-one/",
  "buildContextPath": ".",
  "customDockerBuildArgs": { "AGENT_NAME": "agent-one" }
},
{
  "name": "agent-two",
  "build": "Container",
  "entrypoint": "main.py",
  "codeLocation": "app/agent-two/",
  "buildContextPath": ".",
  "customDockerBuildArgs": { "AGENT_NAME": "agent-two" }
}
```

The shared `Dockerfile` can then branch on the build arg:

```dockerfile
ARG AGENT_NAME
COPY app/${AGENT_NAME}/ ./app/
```

**When to use `buildContextPath`:** use it when your `Dockerfile` needs to `COPY` files that live outside of
`codeLocation` (e.g. shared libraries at the project root). Without it, Docker only sees the `codeLocation` directory as
its build context.

**When to use `customDockerBuildArgs`:** use it to parameterise a shared `Dockerfile` so each agent produces a different
image (different entry point, bundled code, etc.) without duplicating the file.

## Local Development

```bash
agentcore dev
```

For container agents, the dev server:

1. Builds the container image and adds a dev layer with `uvicorn`
2. Runs the container with your source directory volume-mounted at `/app`
3. Enables hot reload via `uvicorn --reload` — code changes apply without rebuilding

AWS credentials are forwarded automatically (environment variables and `~/.aws` mounted read-only).

## Packaging and Deployment

```bash
agentcore package              # Build image locally, validate < 1 GB
agentcore deploy -y            # Build via CodeBuild, push to ECR
```

Local packaging validates the image size (1 GB limit). If no local runtime is available, packaging is skipped and
deployment handles the build remotely.

## Troubleshooting

| Error                      | Fix                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No container runtime found | Install Docker, Podman, or Finch                                                                                                       |
| Runtime not ready          | Docker: start Docker Desktop / `sudo systemctl start docker`. Podman: `podman machine start`. Finch: `finch vm init && finch vm start` |
| Dockerfile not found       | Ensure `Dockerfile` exists in the agent's `codeLocation` directory                                                                     |
| Image exceeds 1 GB         | Use multi-stage builds, minimize packages, review `.dockerignore`                                                                      |
| Build fails                | Check `pyproject.toml` is valid; verify network access for dependency installation                                                     |
