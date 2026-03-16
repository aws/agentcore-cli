# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using LangChain + LangGraph.

## Overview

This agent implements the AG-UI protocol for rich frontend integrations with SSE event streaming.

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
