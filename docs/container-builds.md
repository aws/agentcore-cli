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

The template uses `public.ecr.aws/docker/library/python:3.12-slim` as the base image (with `uv` installed via
`pip install uv`) with these design choices:

- **Layer caching**: Dependencies (`pyproject.toml`) are installed before copying application code
- **Non-root**: Runs as `bedrock_agentcore` (UID 1000)
- **Observability**: Default CMD wraps the agent with `opentelemetry-instrument`
- **Fast installs**: Uses `uv pip install` for dependency resolution

You can customize the Dockerfile freely — add system packages, change the base image, or use multi-stage builds.

### TypeScript Dockerfile

For TypeScript agents, the generated `Dockerfile` uses `public.ecr.aws/docker/library/node:22-slim`:

- **Layer caching**: `package.json` (+ `package-lock.json` if present) is copied first, then `npm ci --omit=dev` runs
  (falls back to `npm install` when no lockfile is present)
- **Non-root**: Runs as `bedrock_agentcore` (UID 1000), matching the Python image
- **Entrypoint**: `npx tsx main.ts` — no compile step, so dev and container runtime share the same entry shape
- **Ports**: Exposes 8080 / 8000 / 9000 to match the HTTP / MCP / A2A contract

During `agentcore dev`, each container receives a unique host port. Multiple A2A agents therefore map ports such as
`9000:9000` and `9001:9000` without conflicting on the host.

Example `agentcore.json` for a TypeScript container agent:

```json
{
  "name": "MyTsAgent",
  "build": "Container",
  "entrypoint": "main.ts",
  "codeLocation": "app/MyTsAgent/",
  "runtimeVersion": "NODE_22"
}
```

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

| Field                   | Description                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildContextPath`      | Docker build context directory. Replaces `codeLocation` as the `docker build` context and as the root the `dockerfile` path is resolved against. |
| `customDockerBuildArgs` | Key/value pairs forwarded as `--build-arg` flags, allowing a shared Dockerfile to branch per agent. Keys must be valid identifiers.              |

Both fields are honored identically by local `agentcore dev` / `agentcore package` and by `agentcore deploy` (which
builds in CodeBuild). The `dockerfile` field is resolved relative to the build context, so with `buildContextPath: "."`
the default `Dockerfile` refers to `./Dockerfile` at the project root. `dockerfile` may also be a relative subpath (e.g.
`docker/Dockerfile` or `.docker/Dockerfile`); absolute paths, `..` traversal, and directory-shaped values (a trailing
slash) are rejected.

**Example — two agents, one shared `Dockerfile` at the project root:**

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

> **Secrets and build junk are excluded from the upload — always.** On `agentcore deploy`, the build context uploaded to
> CodeBuild (whether it's `codeLocation` or a `buildContextPath`) always has a baseline of secret/junk patterns excluded
> — `.env`, `.env.*`, `.git`, `.venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `.DS_Store` — at every depth
> (nested `app/agent-one/.env` and `app/agent-one/node_modules` are excluded too, not just the top level). So a stray
> `.env` is never persisted to the assets bucket or baked into the deployed image, regardless of whether you have a
> `.dockerignore`. Your own `.dockerignore` at the build-context root is honored on top of this baseline (exclude more,
> or re-include a baseline path with a `!pattern` line), and the `Dockerfile` itself is always kept even under an
> allowlist-style (`*`) `.dockerignore`.
>
> **A `.dockerignore` is also generated for local builds when you set `buildContextPath`.** The whole of that directory
> is the build context — for `buildContextPath: "."` that's your entire project — and a local `docker build` honors only
> a real `.dockerignore`. So if none exists at that root, `agentcore dev` / `agentcore package` creates one (the same
> baseline above, listed both bare and `**/`-prefixed, plus `agentcore/`) so your local image matches the deploy upload.
> It's an ordinary file — commit it, and edit it to include anything you intentionally want in the context (e.g. a
> non-secret `.env.production`, by adding a `!.env.production` line).

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

## VPC network mode

A container agent (or dockerfile/prebuilt-image harness) can build and run inside a VPC. The build infrastructure — the
orchestrator Lambda and the shared CodeBuild project — is placed in the same VPC as the runtime:

```bash
agentcore create --project-name MyProject --name myagent \
  --build Container --network-mode VPC \
  --subnets subnet-0123456789abcdef0 --security-groups sg-0123456789abcdef0 \
  --vpc-id vpc-0123456789abcdef0 \
  --language Python --framework Strands --model-provider Bedrock
```

Key points:

- **`--vpc-id` is required for Container builds in VPC mode.** CodeBuild's `CreateProject` cannot infer the VPC from
  subnets alone (unlike Lambda, which does). CodeZip builds and any PUBLIC build neither need nor accept a VPC ID.
- **At most 5 security groups** for a container build in VPC mode (a CodeBuild limit; the runtime itself allows 16).
- **A NAT-routed subnet or VPC endpoints are required** so the in-VPC CodeBuild/Lambda can reach ECR, S3, CloudWatch
  Logs, STS, and CodeBuild. An isolated subnet with no egress will hang the build.
- **The build needs `ec2:DescribeSubnets`** on `import`/`export`/`deploy` to resolve the VPC ID — see
  [PERMISSIONS.md](./PERMISSIONS.md#filesystem-network-validation).

### Upgrading a project created before the VPC ID field existed

Earlier CLI versions let a Container+VPC agent be configured with only subnets and security groups. If you upgrade and
your `agentcore.json` has a Container+VPC agent with no `networkConfig.vpcId`, `deploy` resolves it automatically from
the first subnet (via `ec2:DescribeSubnets`) and writes it back to the config — no manual edit needed. Grant
`ec2:DescribeSubnets` before deploying, or add the `vpcId` to the config by hand.

## Troubleshooting

| Error                               | Fix                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No container runtime found          | Install Docker, Podman, or Finch                                                                                                              |
| Runtime not ready                   | Docker: start Docker Desktop / `sudo systemctl start docker`. Podman: `podman machine start`. Finch: `finch vm init && finch vm start`        |
| Dockerfile not found                | Ensure `Dockerfile` exists in the agent's `codeLocation` directory                                                                            |
| Image exceeds 2 GB                  | Use multi-stage builds, minimize packages, review `.dockerignore`                                                                             |
| `vpcId is required` at deploy/synth | Container+VPC build with no VPC ID. Grant `ec2:DescribeSubnets` so deploy can resolve it, or add `networkConfig.vpcId` to the config manually |
| Build hangs in VPC mode             | The subnet has no egress. Use a NAT-routed subnet or add VPC endpoints (ECR api+dkr, S3, CloudWatch Logs, STS, CodeBuild)                     |
| Build fails                         | Check `pyproject.toml` is valid; verify network access for dependency installation                                                            |
