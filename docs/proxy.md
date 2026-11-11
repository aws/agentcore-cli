# Using the CLI behind an HTTP proxy

The AgentCore CLI routes its AWS traffic through an HTTP(S) proxy when the standard proxy environment variables are set.
This covers every AWS SDK client the CLI creates (STS, CloudFormation, CloudWatch Logs, Bedrock, AgentCore, EC2, S3,
IAM, KMS, X-Ray, ...) and the CDK Toolkit used by `agentcore deploy`.

## Requirements

Node.js **22.21 or later** (or **24.5 or later**). Proxy support relies on Node's built-in `proxyEnv` agent option. On
older versions the CLI prints a warning and connects directly.

## Configuration

| Variable                      | Purpose                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `HTTPS_PROXY` / `https_proxy` | Proxy used for HTTPS requests (all AWS endpoints)                 |
| `HTTP_PROXY` / `http_proxy`   | Proxy used for plain HTTP requests                                |
| `NO_PROXY` / `no_proxy`       | Comma-separated hosts or domains that bypass the proxy            |
| `NODE_USE_ENV_PROXY=1`        | Makes Node's global `fetch` honor the variables above (see below) |

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export HTTP_PROXY=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example.com
export NODE_USE_ENV_PROXY=1

agentcore deploy
```

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://proxy.example.com:3128"
$env:HTTP_PROXY  = "http://proxy.example.com:3128"
$env:NO_PROXY    = "localhost,127.0.0.1"
$env:NODE_USE_ENV_PROXY = "1"
agentcore deploy
```

Proxy credentials can be embedded in the URL (`http://user:password@proxy:3128`). They are redacted from any message the
CLI prints.

## Notes

- Some commands call AgentCore APIs with Node's global `fetch`. Node applies the proxy variables to `fetch` only when
  `NODE_USE_ENV_PROXY=1` is set, so set it together with the proxy variables.
- Keep `localhost` and `127.0.0.1` in `NO_PROXY` so `agentcore dev` can reach the local agent server.
- When a proxy is configured, AWS SDK clients use HTTP/1.1. Node's proxy support does not cover HTTP/2.
- `ALL_PROXY` and SOCKS proxies are not supported.
- Tools the CLI launches as separate processes (Docker, `uv`, `npm`) use their own proxy settings.
