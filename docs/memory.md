# Memory

AgentCore Memory provides persistent context for agents across conversations.

## Adding Memory

```bash
agentcore add memory
```

Or with options:

```bash
agentcore add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30 \
  --owner MyAgent
```

## Swapping or Changing Memory (Strands)

For Strands agents, when you create an agent with memory, the CLI generates a `memory/session.py` file that references a
specific memory via environment variable. To swap which memory your agent uses:

### Step 1: Check Available Memories

Look at your `agentcore/agentcore.json` to see defined memories:

```json
{
  "memories": [
    { "name": "MyAgentMemory", ... },
    { "name": "SharedMemory", ... },
    { "name": "UserPrefMemory", ... }
  ]
}
```

Each memory gets an environment variable: `MEMORY_<NAME>_ID` (uppercase, underscores).

### Step 2: Update session.py

Edit `app/<YourAgent>/memory/session.py` and change the `MEMORY_ID` line:

```python
# Before: using MyAgentMemory
MEMORY_ID = os.getenv("MEMORY_MYAGENTMEMORY_ID")

# After: switch to SharedMemory
MEMORY_ID = os.getenv("MEMORY_SHAREDMEMORY_ID")
```

### Step 3: Redeploy

```bash
agentcore deploy
```

### Adding Memory to an Agent Without Memory (Strands)

If you created an agent without memory and want to add it later:

1. Add a memory to your project:

   ```bash
   agentcore add memory --name MyMemory --strategies SEMANTIC
   ```

2. Create the `memory/` directory in your agent:

   ```bash
   mkdir -p app/MyAgent/memory
   ```

3. Create `app/MyAgent/memory/session.py`:

   ```python
   import os
   from typing import Optional
   from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
   from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

   MEMORY_ID = os.getenv("MEMORY_MYMEMORY_ID")
   REGION = os.getenv("AWS_REGION")

   def get_memory_session_manager(session_id: str, actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
       if not MEMORY_ID:
           return None

       retrieval_config = {
           f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.5),
           f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.5),
       }

       return AgentCoreMemorySessionManager(
           AgentCoreMemoryConfig(
               memory_id=MEMORY_ID,
               session_id=session_id,
               actor_id=actor_id,
               retrieval_config=retrieval_config,
           ),
           REGION
       )
   ```

4. Update `main.py` to use the session manager:

   ```python
   from memory.session import get_memory_session_manager

   @app.entrypoint
   async def invoke(payload, context):
       session_id = getattr(context, 'session_id', 'default-session')
       user_id = getattr(context, 'user_id', 'default-user')
       session_manager = get_memory_session_manager(session_id, user_id)

       agent = Agent(
           model=load_model(),
           session_manager=session_manager,  # Add this line
           ...
       )
   ```

5. Deploy:
   ```bash
   agentcore deploy
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
agentcore add memory --name SharedMemory --owner AgentA

# Bind to AgentB with read access
agentcore add bind memory --agent AgentB --memory SharedMemory --access read
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
