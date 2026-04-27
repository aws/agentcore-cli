# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using Google ADK.

## Overview

This agent implements the AG-UI protocol using Google's Agent Development Kit, enabling rich agent-user interaction via the AG-UI event stream.

## Local Development

```bash
uv sync
uv run python main.py
```

The agent starts on port 8080 and serves requests at `/invocations`.

## Health Check

```
GET /ping
```

Returns `{"status": "healthy"}`.

## Deploy

```bash
agentcore deploy
```
