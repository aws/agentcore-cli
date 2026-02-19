## AgentCore Templates

This directory stores:

- Template assets for agents written in different Languages, SDKs and having different configurations
- Container templates (`container/python/`) with `Dockerfile` and `.dockerignore` for Container build agents

### Directory Layout

```
assets/
├── python/              # Framework templates (one per SDK)
│   ├── strands/
│   ├── langchain_langgraph/
│   ├── crewai/
│   ├── googleadk/
│   ├── openaiagents/
│   └── autogen/
├── container/           # Container build templates
│   └── python/
│       ├── Dockerfile
│       └── dockerignore.template
└── agents/              # AGENTS.md vended to user projects
```

The rendering logic is rooted in the `AgentEnvSpec` and must ALWAYS respect the configuration in the Spec.

For Container builds, `BaseRenderer.render()` automatically copies the `container/<language>/` templates (Dockerfile,
.dockerignore) into the agent directory when `buildType === 'Container'`.

## Guidance for template changes

- Always make sure the templates are as close to working code as possible
- AVOID as much as possible using any conditionals within the templates

## How to use the assets in this directory

- These assets are rendered by the CLI's template renderer in `src/cli/templates/`.
