import {
  BaseBedrockAgentTranslator,
  escapePythonString,
  escapePythonTripleQuoted,
  knowledgeBaseRegion,
  providerFromModelArn,
  pythonIdentifier,
} from "./baseTranslator";
import type {
  BedrockAgentImportNote,
  BedrockAgentImportPlan,
  BedrockAgentImportRequest,
  BedrockAgentSnapshot,
} from "./types";
import { defaultMemoryName, memoryEnvVarName } from "../../../projectSchemas/memory";

export class LangGraphBedrockAgentTranslator extends BaseBedrockAgentTranslator {
  translate(): BedrockAgentImportPlan {
    const rendered = this.renderModule(this.snapshot, true);
    return this.buildPlan(rendered.code, rendered.files, rendered.notes);
  }

  private renderModule(
    snapshot: BedrockAgentSnapshot,
    isRoot: boolean,
  ): {
    code: string;
    files: Record<string, string>;
    notes: BedrockAgentImportNote[];
  } {
    const translator =
      snapshot === this.snapshot
        ? this
        : new LangGraphBedrockAgentTranslator(snapshot, this.requestFor(snapshot));
    const files: Record<string, string> = {};
    const notes: BedrockAgentImportNote[] = [];
    const collaboratorImports: string[] = [];
    const collaboratorTools: string[] = [];
    const collaboratorToolNames: string[] = [];
    const relayingCollaborators: string[] = [];

    for (const collaborator of snapshot.collaborators) {
      const name = pythonIdentifier(collaborator.name);
      const moduleName = `langgraph_collaborator_${name}`;
      const child = translator.renderModule(collaborator.agent, false);
      files[`${moduleName}.py`] = child.code;
      Object.assign(files, child.files);
      notes.push(...child.notes);
      collaboratorImports.push(`from ${moduleName} import invoke_agent as invoke_${name}_agent`);
      // TO_COLLABORATOR means the source agent forwarded its conversation, so the collaborator gets
      // the caller's history. InjectedState is hidden from the model's tool schema; the final
      // message is the query itself and so is dropped.
      const relays = collaborator.relayConversationHistory === "TO_COLLABORATOR";
      collaboratorTools.push(
        relays
          ? `@tool
def invoke_${name}(query: str, state: Annotated[dict, InjectedState]) -> str:
    """${escapePythonTripleQuoted(collaborator.instruction)}"""
    return invoke_${name}_agent(
        query,
        COLLABORATOR_SESSION,
        COLLABORATOR_SESSION,
        list(state.get("messages", [])[:-1]),
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
    const toolNames = [
      ...translator.functionToolNames(),
      ...snapshot.knowledgeBases.map(
        (knowledgeBase) => `retrieve_${pythonIdentifier(knowledgeBase.name)}`,
      ),
      ...collaboratorToolNames,
    ];
    if (
      snapshot.actionGroups.some(
        (group) => group.parentActionSignature === "AMAZON.CodeInterpreter",
      )
    ) {
      notes.push({
        category: "LangGraph code interpreter",
        message:
          "The source agent used AMAZON.CodeInterpreter. The generated LangGraph agent does " +
          "not wire an AgentCore Code Interpreter tool automatically.",
      });
    }

    // A foundation-model ARN carries its provider, so generateModelDefinition emits it. Other ARNs
    // (provisioned-model, inference-profile) do not, and langchain_aws refuses to guess.
    if (
      snapshot.foundationModel.startsWith("arn:") &&
      providerFromModelArn(snapshot.foundationModel) === undefined
    ) {
      notes.push({
        category: "LangGraph model provider",
        message:
          `The source model is the ARN '${snapshot.foundationModel}', which does not name its ` +
          "provider. Uncomment and set the provider argument on the ChatBedrock call in main.py " +
          '(for example provider="anthropic") before invoking the agent.',
      });
    }

    const modelDefinition = translator.generateModelDefinition(snapshot);
    const memoryCode =
      this.request.memory === "none" ? "" : generateLangGraphMemoryCode(this.request);
    const imports = [
      "import asyncio",
      ...(functionTools ? ["import json"] : []),
      ...(this.request.memory === "none" ? [] : ["import os"]),
      ...(isRoot ? ["import uuid"] : []),
      "from collections import OrderedDict",
      "",
      ...(isRoot ? ["from bedrock_agentcore.runtime import BedrockAgentCoreApp"] : []),
      ...(this.request.memory === "none"
        ? []
        : ["from bedrock_agentcore.memory import MemoryClient"]),
      snapshot.knowledgeBases.length > 0
        ? "from langchain_aws import AmazonKnowledgeBasesRetriever, ChatBedrock"
        : "from langchain_aws import ChatBedrock",
      ...(toolNames.length > 0 ? ["from langchain_core.tools import tool"] : []),
      ...(relayingCollaborators.length > 0
        ? ["from typing import Annotated", "from langgraph.prebuilt import InjectedState"]
        : []),
      "from langgraph.checkpoint.memory import InMemorySaver",
      "from langgraph.prebuilt import create_react_agent",
      ...collaboratorImports,
    ].join("\n");

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

${memoryCode}

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
    system_prompt = SYSTEM_PROMPT
${this.request.memory === "none" ? "" : "    system_prompt += retrieve_memory_context(session_id, user_id)\n"}    _agents[key] = create_react_agent(
        model=llm,
        prompt=system_prompt,
        tools=tools,
        checkpointer=InMemorySaver(),
    )
    return _agents[key]


def invoke_agent(question: str, session_id: str, user_id: str${isRoot ? "" : ", relayed_messages: list | None = None"}) -> str:
    agent = get_or_create_agent(session_id, user_id)
    response = asyncio.run(
        agent.ainvoke(
            {"messages": [${isRoot ? "" : "*(relayed_messages or []), "}{"role": "user", "content": question}]},
            {"configurable": {"thread_id": session_id}},
        )
    )
    result = response["messages"][-1].content
${this.request.memory === "none" ? "" : "    store_memory_event(session_id, user_id, question, result)\n"}    return str(result)
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
    # LangGraph runs synchronously; offload it so it cannot block the Runtime event loop.
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
        (knowledgeBase) => `_retriever_${pythonIdentifier(
          knowledgeBase.name,
        )} = AmazonKnowledgeBasesRetriever(
    knowledge_base_id="${escapePythonString(knowledgeBase.id)}",
    retrieval_config={"vectorSearchConfiguration": {"numberOfResults": 10}},
    region_name="${escapePythonString(knowledgeBaseRegion(knowledgeBase, snapshot.region))}",
)

@tool
def retrieve_${pythonIdentifier(knowledgeBase.name)}(query: str) -> str:
    """${escapePythonTripleQuoted(
      knowledgeBase.description ?? `Retrieve from ${knowledgeBase.name}`,
    )}"""
    documents = _retriever_${pythonIdentifier(knowledgeBase.name)}.invoke(query)
    return "\\n\\n".join(document.page_content for document in documents)`,
      )
      .join("\n\n");
  }

  private generateModelDefinition(snapshot: BedrockAgentSnapshot): string {
    const provider = providerFromModelArn(snapshot.foundationModel);
    const providerArg = provider
      ? `\n    provider="${escapePythonString(provider)}",`
      : snapshot.foundationModel.startsWith("arn:")
        ? `\n    # TODO: langchain_aws cannot infer a provider from this ARN. See IMPORT_NOTES.md.\n    # provider="anthropic",`
        : "";
    const inference = snapshot.inferenceConfiguration;
    const modelKwargs = {
      ...(inference?.temperature !== undefined && { temperature: inference.temperature }),
      ...(inference?.maximumLength !== undefined && { max_tokens: inference.maximumLength }),
      ...(inference?.topP !== undefined && { top_p: inference.topP }),
      ...(inference?.topK !== undefined && { top_k: inference.topK }),
      ...(inference?.stopSequences !== undefined && { stop_sequences: inference.stopSequences }),
    };
    const guardrails = snapshot.guardrail
      ? `,\n    guardrails=${JSON.stringify({
          guardrailIdentifier: snapshot.guardrail.identifier,
          guardrailVersion: snapshot.guardrail.version,
        })}`
      : "";
    return `llm = ChatBedrock(
    model_id="${escapePythonString(snapshot.foundationModel)}",
    region_name="${escapePythonString(snapshot.region)}",${providerArg}
    model_kwargs=${JSON.stringify(modelKwargs)}${guardrails}
)`;
  }

  private requestFor(snapshot: BedrockAgentSnapshot): BedrockAgentImportRequest {
    return {
      ...this.request,
      runtimeName: pythonIdentifier(snapshot.agentName),
    };
  }
}

function generateLangGraphMemoryCode(request: BedrockAgentImportRequest): string {
  const memoryEnv = memoryEnvVarName(defaultMemoryName(request.runtimeName));
  const retrieval =
    request.memory === "longAndShortTerm"
      ? `    memories = []
    for namespace, query in (
        (f"/users/{user_id}/facts", "Retrieve relevant facts."),
        (f"/users/{user_id}/preferences", "Retrieve user preferences."),
        (f"/episodes/{user_id}/{session_id}", "Retrieve relevant episodes."),
        (f"/summaries/{user_id}", "Retrieve recent summaries."),
    ):
        memories.extend(
            memory_client.retrieve_memories(
                memory_id=MEMORY_ID,
                namespace_path=namespace,
                query=query,
                actor_id=user_id,
                top_k=3,
            )
        )
    text = "\\n".join(
        memory.get("content", {}).get("text", "") for memory in memories
    )
    return f"\\n\\nRelevant memory:\\n{text}" if text else ""
`
      : '    return ""\n';
  return `MEMORY_ID = os.getenv("${memoryEnv}")
memory_client = MemoryClient()


def retrieve_memory_context(session_id: str, user_id: str) -> str:
    if not MEMORY_ID:
        return ""
${retrieval}

def store_memory_event(session_id: str, user_id: str, prompt: str, response: str):
    if not MEMORY_ID:
        return
    memory_client.create_event(
        memory_id=MEMORY_ID,
        actor_id=user_id,
        session_id=session_id,
        messages=[(prompt, "USER"), (response, "ASSISTANT")],
    )
`;
}
