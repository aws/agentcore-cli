import {
  BaseBedrockAgentTranslator,
  escapePythonString,
  escapePythonTripleQuoted,
  knowledgeBaseRegion,
  pythonIdentifier,
} from "./baseTranslator";
import type {
  BedrockAgentImportNote,
  BedrockAgentImportPlan,
  BedrockAgentImportRequest,
  BedrockAgentSnapshot,
} from "./types";
import { defaultMemoryName, memoryEnvVarName } from "../../../projectSchemas/memory";

export class StrandsBedrockAgentTranslator extends BaseBedrockAgentTranslator {
  translate(): BedrockAgentImportPlan {
    const rendered = this.renderModule(this.snapshot, true);
    return this.buildPlan(rendered.code, rendered.files, rendered.notes);
  }

  private renderModule(
    snapshot: BedrockAgentSnapshot,
    isRoot: boolean,
  ): { code: string; files: Record<string, string>; notes: BedrockAgentImportNote[] } {
    const translator =
      snapshot === this.snapshot
        ? this
        : new StrandsBedrockAgentTranslator(snapshot, this.requestFor(snapshot));
    const files: Record<string, string> = {};
    const notes: BedrockAgentImportNote[] = [];
    const collaboratorImports: string[] = [];
    const collaboratorTools: string[] = [];
    const collaboratorToolNames: string[] = [];
    const relayingCollaborators: string[] = [];

    for (const collaborator of snapshot.collaborators) {
      const name = pythonIdentifier(collaborator.name);
      const moduleName = `strands_collaborator_${name}`;
      const child = translator.renderModule(collaborator.agent, false);
      files[`${moduleName}.py`] = child.code;
      Object.assign(files, child.files);
      notes.push(...child.notes);
      collaboratorImports.push(`from ${moduleName} import invoke_agent as invoke_${name}_agent`);
      // TO_COLLABORATOR means the source agent forwarded its conversation, so the collaborator gets
      // the caller's history. ToolContext hands the tool the invoking agent, whose last message is
      // the query itself and so is dropped.
      const relays = collaborator.relayConversationHistory === "TO_COLLABORATOR";
      collaboratorTools.push(
        relays
          ? `@tool(context=True)
def invoke_${name}(query: str, tool_context: ToolContext) -> str:
    """${escapePythonTripleQuoted(collaborator.instruction)}"""
    return invoke_${name}_agent(
        query,
        COLLABORATOR_SESSION,
        COLLABORATOR_SESSION,
        list(tool_context.agent.messages[:-1]),
    )`
          : `@tool
def invoke_${name}(query: str) -> str:
    """${escapePythonTripleQuoted(collaborator.instruction)}"""
    return invoke_${name}_agent(query, COLLABORATOR_SESSION, COLLABORATOR_SESSION)`,
      );
      if (relays) relayingCollaborators.push(name);
      collaboratorToolNames.push(`invoke_${name}`);
      notes.push({
        category: "collaborator session scope",
        message:
          `Collaborator '${collaborator.name}' runs under a shared session rather than the ` +
          "caller's session, so its own history is not isolated per end user.",
      });
    }

    const functionTools = translator.generateFunctionTools();
    const knowledgeBaseTools = translator.generateKnowledgeBaseTools(snapshot);
    const codeInterpreter = snapshot.actionGroups.some(
      (group) => group.parentActionSignature === "AMAZON.CodeInterpreter",
    );
    const toolNames = [
      ...translator.functionToolNames(),
      ...snapshot.knowledgeBases.map(
        (knowledgeBase) => `retrieve_${pythonIdentifier(knowledgeBase.name)}`,
      ),
      ...collaboratorToolNames,
      ...(codeInterpreter ? ["AgentCoreCodeInterpreter().code_interpreter"] : []),
    ];
    if (snapshot.guardrail) {
      notes.push({
        category: "Strands guardrail",
        message:
          `Guardrail '${snapshot.guardrail.identifier}' version ` +
          `'${snapshot.guardrail.version}' was not attached because Strands BedrockModel ` +
          "does not expose equivalent guardrail configuration.",
      });
    }

    const modelDefinition = translator.generateModelDefinition(snapshot);
    const memoryModule =
      this.request.memory === "none" ? undefined : generateStrandsMemoryModule(this.request);
    if (isRoot && memoryModule) files["memory.py"] = memoryModule;

    const imports = [
      ...(isRoot ? ["import asyncio"] : []),
      ...(functionTools ? ["import json"] : []),
      ...(isRoot ? ["import uuid"] : []),
      "from collections import OrderedDict",
      "",
      ...(snapshot.knowledgeBases.length > 0 ? ["import boto3"] : []),
      ...(isRoot ? ["from bedrock_agentcore.runtime import BedrockAgentCoreApp"] : []),
      toolNames.length > 0 ? "from strands import Agent, tool" : "from strands import Agent",
      ...(relayingCollaborators.length > 0 ? ["from strands.types.tools import ToolContext"] : []),
      "from strands.models import BedrockModel",
      ...(codeInterpreter
        ? ["from strands_tools.code_interpreter import AgentCoreCodeInterpreter"]
        : []),
      ...(memoryModule ? ["from memory import get_memory_session_manager"] : []),
      ...collaboratorImports,
    ].join("\n");

    // Only the root module owns the Runtime entrypoint. A collaborator module is imported by the
    // root, so a second BedrockAgentCoreApp()/@app.entrypoint there would register at import time.
    const code = `# Generated from Bedrock Agent "${escapePythonString(snapshot.agentName)}" version "${escapePythonString(snapshot.sourceAgentVersion)}".
# Review IMPORT_NOTES.md before deploying.

${imports}
${isRoot ? "\napp = BedrockAgentCoreApp()" : ""}
${collaboratorToolNames.length > 0 ? 'COLLABORATOR_SESSION = "collaborator"\n' : ""}

${modelDefinition}

${translator.generateSystemPrompt()}

${functionTools}

${knowledgeBaseTools}

${collaboratorTools.join("\n\n")}

tools = [${toolNames.join(", ")}]
# Reuses one agent per session/user so each session keeps its own history, capped at 128
# entries with LRU eviction so a process serving many sessions cannot leak history
# between them or grow without limit.
_agents = OrderedDict()


def get_or_create_agent(session_id: str, user_id: str):
    key = f"{session_id}/{user_id}"
    if key in _agents:
        _agents.move_to_end(key)
        return _agents[key]
    if len(_agents) >= 128:
        _agents.popitem(last=False)
    _agents[key] = Agent(
        model=llm,
        system_prompt=SYSTEM_PROMPT,
        tools=tools,
${memoryModule ? "        session_manager=get_memory_session_manager(session_id, user_id),\n" : ""}    )
    return _agents[key]


def invoke_agent(question: str, session_id: str, user_id: str${isRoot ? "" : ", relayed_messages: list | None = None"}) -> str:
    agent = get_or_create_agent(session_id, user_id)
${isRoot ? "" : "    if relayed_messages:\n        agent.messages = list(relayed_messages)\n"}    return str(agent(question))
${
  isRoot
    ? `

def _validate_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object with a non-empty 'prompt' field")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        raise ValueError("expected a JSON object with a non-empty 'prompt' field")
    return prompt


@app.entrypoint
async def invoke(payload, context):
    try:
        prompt = _validate_payload(payload)
    except ValueError as error:
        yield f"Invalid payload; {error}."
        return

    session_id = getattr(context, "session_id", None) or payload.get("sessionId") or uuid.uuid4().hex
    user_id = getattr(context, "user_id", None) or payload.get("userId") or "default-user"
    # Strands runs synchronously; offload it so it cannot block the Runtime event loop.
    yield await asyncio.to_thread(invoke_agent, prompt, session_id, user_id)


if __name__ == "__main__":
    app.run()
`
    : ""
}`;
    return { code, files, notes };
  }

  private generateKnowledgeBaseTools(snapshot: BedrockAgentSnapshot): string {
    return snapshot.knowledgeBases
      .map(
        (knowledgeBase) => `@tool
def retrieve_${pythonIdentifier(knowledgeBase.name)}(query: str):
    """${escapePythonTripleQuoted(
      knowledgeBase.description ?? `Retrieve from ${knowledgeBase.name}`,
    )}"""
    client = boto3.client("bedrock-agent-runtime", region_name="${escapePythonString(
      knowledgeBaseRegion(knowledgeBase, snapshot.region),
    )}")
    return client.retrieve(
        retrievalQuery={"text": query},
        knowledgeBaseId="${escapePythonString(knowledgeBase.id)}",
        retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": 10}},
    ).get("retrievalResults", [])`,
      )
      .join("\n\n");
  }

  private generateModelDefinition(snapshot: BedrockAgentSnapshot): string {
    const inference = snapshot.inferenceConfiguration;
    const args = [
      `model_id="${escapePythonString(snapshot.foundationModel)}"`,
      `region_name="${escapePythonString(snapshot.region)}"`,
      inference?.temperature !== undefined ? `temperature=${inference.temperature}` : undefined,
      inference?.maximumLength !== undefined ? `max_tokens=${inference.maximumLength}` : undefined,
      inference?.topP !== undefined ? `top_p=${inference.topP}` : undefined,
      inference?.topK !== undefined ? `top_k=${inference.topK}` : undefined,
      inference?.stopSequences !== undefined
        ? `stop_sequences=${JSON.stringify(inference.stopSequences)}`
        : undefined,
    ].filter(Boolean);
    return `llm = BedrockModel(
    ${args.join(",\n    ")}
)`;
  }

  private requestFor(snapshot: BedrockAgentSnapshot): BedrockAgentImportRequest {
    return {
      ...this.request,
      runtimeName: pythonIdentifier(snapshot.agentName),
    };
  }
}

function generateStrandsMemoryModule(request: BedrockAgentImportRequest): string {
  const memoryEnv = memoryEnvVarName(defaultMemoryName(request.runtimeName));
  const retrievalConfig =
    request.memory === "longAndShortTerm"
      ? `    retrieval_config = {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.5),
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.5),
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.5),
        f"/summaries/{actor_id}": RetrievalConfig(top_k=3, relevance_score=0.5),
    }
`
      : "    retrieval_config = {}\n";
  return `import os

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("${memoryEnv}")
REGION = os.getenv("AWS_REGION")


def get_memory_session_manager(session_id: str, actor_id: str):
    if not MEMORY_ID:
        return None

${retrievalConfig}
    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
            retrieval_config=retrieval_config,
        ),
        REGION,
    )
`;
}
