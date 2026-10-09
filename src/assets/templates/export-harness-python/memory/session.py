import os

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig{{#if (or memoryStrategies.length memoryRetrievalNamespaces)}}, RetrievalConfig{{/if}}
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("{{memoryEnvVarName}}")
REGION = {{#if memoryRegion}}{{safeJson memoryRegion}}{{else}}os.getenv("AWS_REGION"){{/if}}


def get_memory_session_manager(
    session_id: str, actor_id: str
) -> AgentCoreMemorySessionManager:
    if not MEMORY_ID:
        raise RuntimeError("Missing memory binding: {{memoryEnvVarName}}")

{{#if memoryRetrievalNamespaces}}
    retrieval_config = {
{{#each memoryRetrievalNamespaces}}
        {{safeJson namespace}}: RetrievalConfig(top_k={{topK}}, relevance_score={{relevanceScore}}{{#if strategyId}}, strategy_id={{safeJson strategyId}}{{/if}}),
{{/each}}
    }
{{else}}
{{#if memoryStrategies.length}}
    retrieval_config = {
{{#if (includes memoryStrategies "SEMANTIC")}}
        f"/users/{actor_id}/facts": RetrievalConfig(top_k={{#if memoryRetrievalTopK}}{{memoryRetrievalTopK}}{{else}}3{{/if}}, relevance_score={{#if memoryRetrievalRelevanceScore}}{{memoryRetrievalRelevanceScore}}{{else}}0.5{{/if}}),
{{/if}}
{{#if (includes memoryStrategies "USER_PREFERENCE")}}
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k={{#if memoryRetrievalTopK}}{{memoryRetrievalTopK}}{{else}}3{{/if}}, relevance_score={{#if memoryRetrievalRelevanceScore}}{{memoryRetrievalRelevanceScore}}{{else}}0.5{{/if}}),
{{/if}}
{{#if (includes memoryStrategies "EPISODIC")}}
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k={{#if memoryRetrievalTopK}}{{memoryRetrievalTopK}}{{else}}5{{/if}}, relevance_score={{#if memoryRetrievalRelevanceScore}}{{memoryRetrievalRelevanceScore}}{{else}}0.5{{/if}}),
{{/if}}
{{#if (includes memoryStrategies "SUMMARIZATION")}}
        f"/summaries/{actor_id}": RetrievalConfig(top_k={{#if memoryRetrievalTopK}}{{memoryRetrievalTopK}}{{else}}3{{/if}}, relevance_score={{#if memoryRetrievalRelevanceScore}}{{memoryRetrievalRelevanceScore}}{{else}}0.5{{/if}}),
{{/if}}
    }
{{/if}}
{{/if}}

    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
{{#if (or memoryStrategies.length memoryRetrievalNamespaces)}}
            retrieval_config=retrieval_config,
{{/if}}
        ),
        REGION,
    )
