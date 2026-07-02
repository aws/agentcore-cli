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
