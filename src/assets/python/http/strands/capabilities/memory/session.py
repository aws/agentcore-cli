import os
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig{{#if memoryProviders.[0].strategies.length}}, RetrievalConfig{{/if}}
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("{{memoryProviders.[0].envVarName}}")
REGION = os.getenv("AWS_REGION")

def get_memory_session_manager(session_id: str, actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        return None

{{#if memoryProviders.[0].strategies.length}}
    retrieval_config = {
{{#if (includes memoryProviders.[0].strategies "SEMANTIC")}}
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
{{#if (includes memoryProviders.[0].strategies "USER_PREFERENCE")}}
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
{{#if (includes memoryProviders.[0].strategies "SUMMARIZATION")}}
        f"/summaries/{actor_id}/{session_id}": RetrievalConfig(top_k=3, relevance_score=0.5),
{{/if}}
    }
{{/if}}

    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
{{#if memoryProviders.[0].strategies.length}}
            retrieval_config=retrieval_config,
{{/if}}
        ),
        REGION
    )

