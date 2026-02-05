# Memory

AgentCore Memory provides persistent context for agents across conversations.

## Adding Memory

```bash
agentcore-cli add memory
```

Or with options:

```bash
agentcore-cli add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30 \
  --owner MyAgent
```

## Memory Strategies

| Strategy          | Description                                         |
| ----------------- | --------------------------------------------------- |
| `SEMANTIC`        | Vector-based similarity search for relevant context |
| `SUMMARIZATION`   | Compressed conversation history                     |
| `USER_PREFERENCE` | Store user-specific preferences and settings        |
| `CUSTOM`          | Custom strategy implementation                      |

You can combine multiple strategies:

```json
{
  "memoryStrategies": [{ "type": "SEMANTIC" }, { "type": "SUMMARIZATION" }, { "type": "USER_PREFERENCE" }]
}
```

### Strategy Options

Each strategy can have optional configuration:

```json
{
  "type": "SEMANTIC",
  "name": "custom_semantic",
  "description": "Custom semantic memory",
  "namespaces": ["/users/facts", "/users/preferences"]
}
```

| Field         | Required | Description                                     |
| ------------- | -------- | ----------------------------------------------- |
| `type`        | Yes      | Strategy type                                   |
| `name`        | No       | Custom name (defaults to `<memoryName>-<type>`) |
| `description` | No       | Strategy description                            |
| `namespaces`  | No       | Array of namespace paths for scoping            |

## Event Expiry

Memory events expire after a configurable duration (7-365 days, default 30):

```json
{
  "config": {
    "eventExpiryDuration": 90,
    "memoryStrategies": [...]
  }
}
```

## Ownership Model

### Owned Memory

The agent creates and manages the memory resource:

```json
{
  "type": "AgentCoreMemory",
  "relation": "own",
  "name": "MyMemory",
  "description": "Agent's private memory",
  "envVarName": "AGENTCORE_MEMORY_MYMEMORY",
  "config": {
    "eventExpiryDuration": 30,
    "memoryStrategies": [{ "type": "SEMANTIC" }]
  }
}
```

### Referenced Memory

The agent uses another agent's memory:

```json
{
  "type": "AgentCoreMemory",
  "relation": "use",
  "name": "SharedMemory",
  "description": "Reference to shared memory",
  "envVarName": "AGENTCORE_MEMORY_SHARED",
  "access": "read"
}
```

| Access Level | Description                      |
| ------------ | -------------------------------- |
| `read`       | Can retrieve from memory         |
| `readwrite`  | Can retrieve and store (default) |

## Sharing Memory

To share memory between agents:

1. One agent owns the memory (`relation: "own"`)
2. Other agents reference it (`relation: "use"`)

```bash
# Create memory owned by AgentA
agentcore-cli add memory --name SharedMemory --owner AgentA

# Bind to AgentB with read access
agentcore-cli add bind memory --agent AgentB --memory SharedMemory --access read
```

## Removal Policy

When removing an agent that owns memory:

| Policy     | Behavior                                        |
| ---------- | ----------------------------------------------- |
| `cascade`  | Delete memory and clean up references (default) |
| `restrict` | Prevent removal if other agents use the memory  |

```json
{
  "relation": "own",
  "removalPolicy": "restrict",
  ...
}
```

## Using Memory in Code

The memory ID is available via environment variable:

```python
import os
from bedrock_agentcore.memory import AgentCoreMemory

memory_id = os.getenv("AGENTCORE_MEMORY_MYMEMORY")
memory = AgentCoreMemory(memory_id=memory_id)
```

For Strands agents, memory is integrated via session manager - see the generated `memory/session.py` file.
