# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using Strands SDK.

## Overview

This agent implements the AG-UI protocol, enabling rich frontend integrations with SSE event streaming (RUN_STARTED, TEXT_MESSAGE_CONTENT, RUN_FINISHED).

## Local Development

```bash
uv sync
uv run python main.py
```

The agent starts on port 8080.

## Deploy

```bash
agentcore deploy
```
