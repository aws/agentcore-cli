# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using LangChain + LangGraph.

## Overview

This agent implements the AG-UI protocol using LangGraph, enabling seamless frontend-to-agent communication with support for streaming, tool calls, and frontend-injected tools.

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
