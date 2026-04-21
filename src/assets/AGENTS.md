## AgentCore Templates

This directory stores:

- Template assets for agents written in different languages, SDKs, and configurations
- Container templates (`container/python/`) with `Dockerfile` and `.dockerignore` for Container build agents
- Vended documentation (`README.md`, `agents/AGENTS.md`) copied into user projects at create time
- CDK project template (`cdk/`) using `@aws/agentcore-cdk` L3 constructs
- Evaluator templates (`evaluators/`) for code-based evaluators
- MCP tool templates (`mcp/`) for Lambda and AgentCoreRuntime compute

### Directory Layout

```
assets/
├── README.md            # Vended to project root as project README
├── AGENTS.md            # This file — internal dev context
├── agents/
│   └── AGENTS.md        # Vended to project root for AI coding assistants
├── python/              # Framework templates (one per SDK per protocol)
│   ├── http/            # HTTP protocol agents
│   │   ├── strands/
│   │   ├── langchain_langgraph/
│   │   ├── googleadk/
│   │   ├── openaiagents/
│   │   └── autogen/
│   ├── mcp/             # MCP protocol agents
│   │   └── standalone/
│   └── a2a/             # A2A protocol agents
│       ├── strands/
│       ├── langchain_langgraph/
│       └── googleadk/
├── typescript/          # TypeScript agent templates
├── container/           # Container build templates
│   └── python/
│       ├── Dockerfile
│       └── dockerignore.template
├── cdk/                 # CDK project template (@aws/agentcore-cdk)
├── evaluators/          # Code-based evaluator templates
└── mcp/                 # MCP tool templates (Lambda + AgentCoreRuntime)
    ├── python/
    └── python-lambda/
```

The rendering logic is rooted in the `AgentEnvSpec` and must ALWAYS respect the configuration in the spec.

For Container builds, `BaseRenderer.render()` automatically copies the `container/<language>/` templates (Dockerfile,
.dockerignore) into the agent directory when `buildType === 'Container'`.

## Guidance for template changes

- Always make sure the templates are as close to working code as possible
- AVOID as much as possible using any conditionals within the templates
- Test template rendering with `agentcore add agent` for each framework/protocol combination

## How to use the assets in this directory

- These assets are rendered by the CLI's template renderer in `src/cli/templates/`
- The `README.md` and `agents/AGENTS.md` are copied verbatim (no template rendering) during project creation
- The `.llm-context/` files are sourced from `src/schema/llm-compacted/` and written during init
