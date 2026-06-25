# Gateway

Gateways act as MCP-compatible proxies that route agent requests to backend tools. They handle authentication, tool
discovery, and request routing so your agents can securely access external MCP servers and APIs.

## Quick Start

The simplest path is to set up your gateway before creating your agent. The agent template will automatically include
the gateway client code.

```bash
# 1. Create a project
agentcore create --name MyProject --framework Strands --model-provider Bedrock
cd MyProject

# 2. Add a gateway
agentcore add gateway --name my-gateway

# 3. Add a target (external MCP server)
agentcore add gateway-target \
  --type mcp-server \
  --name weather-tools \
  --endpoint https://mcp.example.com/mcp \
  --gateway my-gateway

# 4. Create an agent (automatically wired to the gateway)
agentcore add agent --name MyAgent --framework Strands --model-provider Bedrock

# 5. Deploy
agentcore deploy -y
```

The generated agent code includes gateway client setup, authentication, and environment variable reading out of the box.

## Gateway Targets

A gateway target is a backend tool source exposed through a gateway. The gateway proxies requests to the target and
handles tool discovery and authentication. There are five target types.

### MCP Server (`mcp-server`)

Connect to an external MCP server endpoint, or deploy a managed MCP server on Lambda/AgentCoreRuntime
(Python/TypeScript).

```bash
agentcore add gateway-target \
  --type mcp-server \
  --name my-tools \
  --endpoint https://mcp.example.com/mcp \
  --gateway my-gateway
```

Supports outbound auth: `oauth` or `none`.

### API Gateway REST API (`api-gateway`)

Connect to an existing Amazon API Gateway REST API. The gateway auto-discovers tools from API routes.

```bash
agentcore add gateway-target \
  --type api-gateway \
  --name PetStore \
  --rest-api-id abc123 \
  --stage prod \
  --tool-filter-path '/pets/*' \
  --tool-filter-methods GET,POST \
  --gateway my-gateway
```

Supports outbound auth: `api-key` or `none`. OAuth is not supported for API Gateway targets.

### OpenAPI Schema (`open-api-schema`)

Auto-derive tools from an OpenAPI JSON specification file.

```bash
agentcore add gateway-target \
  --type open-api-schema \
  --name PetStoreAPI \
  --schema specs/petstore.json \
  --gateway my-gateway \
  --outbound-auth oauth \
  --credential-name MyOAuth
```

Outbound auth is required (`oauth` or `api-key`). Schema path is relative to project root.

### Smithy Model (`smithy-model`)

Auto-derive tools from a Smithy JSON model file.

```bash
agentcore add gateway-target \
  --type smithy-model \
  --name MyService \
  --schema models/service.json \
  --gateway my-gateway
```

Uses IAM role auth — no outbound auth needed. Schema path is relative to project root.

### Lambda Function ARN (`lambda-function-arn`)

Connect to an existing AWS Lambda function by ARN. Tools are defined via a JSON schema file rather than code
scaffolding.

```bash
agentcore add gateway-target \
  --type lambda-function-arn \
  --name MyLambdaTools \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:my-func \
  --tool-schema-file tools.json \
  --gateway my-gateway
```

Uses IAM role auth exclusively — no outbound auth is allowed. The tool schema file path is relative to project root (or
an absolute path) and is uploaded to S3 during deployment.

## Authentication

### Inbound Authentication

Controls how agents authenticate with the gateway.

| Type         | Description                                  | Use Case             |
| ------------ | -------------------------------------------- | -------------------- |
| `NONE`       | No authentication required                   | Development, testing |
| `AWS_IAM`    | SigV4 signed requests                        | AWS-native agents    |
| `CUSTOM_JWT` | OIDC-based JWT validation with Bearer tokens | External IdPs, M2M   |

#### CUSTOM_JWT Setup

```bash
agentcore add gateway \
  --name my-gateway \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --allowed-audience my-api \
  --allowed-clients my-client-id \
  --client-id agent-client-id \
  --client-secret agent-client-secret
```

When you provide `--client-id` and `--client-secret`, the CLI automatically creates a managed OAuth credential that your
agent uses to obtain Bearer tokens at runtime.

### Outbound Authentication

Controls how the gateway authenticates with upstream targets. Configured per target.

| Type      | Description                    | Supported Target Types                        |
| --------- | ------------------------------ | --------------------------------------------- |
| `none`    | No outbound authentication     | mcp-server, api-gateway                       |
| `oauth`   | OAuth2 client credentials flow | mcp-server, open-api-schema                   |
| `api-key` | API key passed to upstream     | api-gateway, open-api-schema                  |
| IAM role  | Automatic IAM role auth        | smithy-model, lambda-function-arn (exclusive) |

#### OAuth Outbound Auth

```bash
agentcore add gateway-target \
  --type mcp-server \
  --name secure-tools \
  --endpoint https://api.example.com/mcp \
  --gateway my-gateway \
  --outbound-auth oauth \
  --oauth-client-id my-client \
  --oauth-client-secret my-secret \
  --oauth-discovery-url https://auth.example.com/.well-known/openid-configuration
```

You can also reference an existing credential:

```bash
agentcore add credential \
  --name MyOAuthProvider \
  --type oauth \
  --discovery-url https://auth.example.com/.well-known/openid-configuration \
  --client-id my-client \
  --client-secret my-secret

agentcore add gateway-target \
  --type mcp-server \
  --name secure-tools \
  --endpoint https://api.example.com/mcp \
  --gateway my-gateway \
  --outbound-auth oauth \
  --credential-name MyOAuthProvider
```

## Adding a Gateway to an Existing Project

If you already have agents and want to add gateway support, there are two approaches.

### Recommended: Create a New Agent

The simplest path is to create a new agent after configuring your gateway. The new agent template will automatically
include gateway client code with the correct authentication for your framework.

```bash
# 1. Add gateway and targets
agentcore add gateway --name my-gateway
agentcore add gateway-target \
  --type mcp-server \
  --name my-tools \
  --endpoint https://mcp.example.com/mcp \
  --gateway my-gateway

# 2. Create a new agent (picks up gateway config automatically)
agentcore add agent --name MyNewAgent --framework Strands --model-provider Bedrock

# 3. Move your custom logic from the old agent to the new one
#    Copy tool definitions, prompts, and business logic from:
#      app/MyOldAgent/ → app/MyNewAgent/

# 4. Remove the old agent when ready
agentcore remove agent --name MyOldAgent
```

### Manual: Update Existing Agent Code

If you have a heavily customized agent that can't be easily recreated, you can manually add gateway client code. The
exact code depends on your framework and gateway auth type.

To get the correct code for your setup:

1. Configure your gateway and targets as above.

2. Create a temporary reference agent:

   ```bash
   agentcore add agent \
     --name TempAgent \
     --framework Strands \
     --model-provider Bedrock
   ```

3. Copy the gateway-related code from the generated agent into your existing agent:
   - `app/TempAgent/mcp_client/client.py` — Gateway client with authentication
   - `app/TempAgent/main.py` — Import and usage of gateway MCP clients

4. Add the `mcp-proxy-for-aws` dependency to your agent's `pyproject.toml` (required for AWS_IAM authentication).

5. Remove the temporary agent:
   ```bash
   agentcore remove agent --name TempAgent
   ```

## Gateway Configuration Options

Gateways support additional configuration fields in `agentcore.json`:

| Field                  | Default | Description                                                      |
| ---------------------- | ------- | ---------------------------------------------------------------- |
| `enableSemanticSearch` | `true`  | Enable semantic search for tool discovery                        |
| `exceptionLevel`       | `NONE`  | Exception verbosity: `"NONE"` or `"DEBUG"` (for troubleshooting) |

```json
{
  "agentCoreGateways": [
    {
      "name": "MyGateway",
      "enableSemanticSearch": false,
      "exceptionLevel": "DEBUG",
      "targets": [...]
    }
  ]
}
```

## Local Development

When you have deployed gateways, `agentcore dev` automatically injects gateway environment variables into your local
agent process. See [Local Development](local-development.md#gateway-environment-variables) for details.

Gateway env vars require a prior deployment — run `agentcore deploy` before `agentcore dev` to populate the gateway
URLs.
