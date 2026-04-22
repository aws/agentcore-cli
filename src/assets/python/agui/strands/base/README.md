# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using Strands SDK.

## Overview

This agent implements the AG-UI protocol, enabling streaming agent-to-UI communication. The agent exposes an `/invocations` endpoint that accepts AG-UI protocol requests and streams responses back to the client.

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
