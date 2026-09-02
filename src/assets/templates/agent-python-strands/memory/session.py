import os
import uuid
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig{{#if memoryStrategies.length}}, RetrievalConfig{{/if}}
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("{{memoryEnvVarName}}")
REGION = os.getenv("AWS_REGION")


def get_memory_session_manager(
    session_id: Optional[str], actor_id: str
) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        return None

    session_id = session_id or uuid.uuid4().hex

{{#if memoryStrategies.length}}
    retrieval_config = {
{{#if (includes memoryStrategies "SEMANTIC")}}
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
{{#if (includes memoryStrategies "USER_PREFERENCE")}}
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
{{#if (includes memoryStrategies "EPISODIC")}}
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.5),
{{/if}}
{{#if (includes memoryStrategies "SUMMARIZATION")}}
        f"/summaries/{actor_id}": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
    }
{{/if}}

    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
{{#if memoryStrategies.length}}
            retrieval_config=retrieval_config,
{{/if}}
        ),
        REGION,
    )
