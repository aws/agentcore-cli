# {{ name }}

An A2A (Agent-to-Agent) agent deployed on Amazon Bedrock AgentCore using Google ADK.

## Overview

This agent implements the A2A protocol using Google's Agent Development Kit, enabling agent-to-agent communication.

## Local Development

```bash
uv sync
uv run python main.py
```

The agent starts on port 9000.

## Deploy

```bash
agentcore deploy
```
