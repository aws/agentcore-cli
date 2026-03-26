# {{ name }}

An A2A (Agent-to-Agent) agent deployed on Amazon Bedrock AgentCore using LangChain + LangGraph.

## Overview

This agent implements the A2A protocol using LangGraph, enabling agent-to-agent communication.

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
