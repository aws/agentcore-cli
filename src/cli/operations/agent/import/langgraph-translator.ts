/**
 * LangChain/LangGraph-specific translator for Bedrock Agent import.
 * Port of the starter toolkit's bedrock_to_langchain.py.
 */
import type { BedrockAgentConfig } from '../../../aws/bedrock-import-types';
import type { TranslationResult, TranslatorOptions } from './base-translator';
import { BaseBedrockTranslator, sanitizePyIdentifier } from './base-translator';

export class LangGraphTranslator extends BaseBedrockTranslator {
  constructor(
    config: BedrockAgentConfig,
    options: TranslatorOptions,
    collaboratorContext?: { name: string; instruction: string; relayHistory: string }
  ) {
    super(config, options, collaboratorContext);
  }

  translate(): TranslationResult {
    const collaboratorFiles = new Map<string, string>();

    // Build code sections
    let importsCode = this.importsCode + this.generateLangChainImports();
    const promptsCode = this.generatePrompts();
    const modelsCode = this.generateModelConfigurations();
    const collaborationCode = this.generateCollaborationCode(collaboratorFiles);
    const toolsCode = this.generateFunctionActionGroupTools();
    const memoryCode = this.generateMemoryCode('InMemorySaver');
    const kbCode = this.generateKnowledgeBaseCode();
    const agentSetupCode = this.generateAgentSetup();
    const entrypointCode = this.generateEntrypointCode('langchain');

    if (this.observabilityEnabled) {
      importsCode += `
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
LangchainInstrumentor().instrument()
`;
    }

    const mainPyContent = this.assembleCode([
      importsCode,
      modelsCode,
      promptsCode,
      collaborationCode,
      toolsCode,
      memoryCode,
      kbCode,
      agentSetupCode,
      entrypointCode,
    ]);

    return {
      mainPyContent,
      collaboratorFiles,
      features: this.getFeatures(),
    };
  }

  private generateLangChainImports(): string {
    return `
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from langchain_aws import ChatBedrock
from langchain_aws.retrievers import AmazonKnowledgeBasesRetriever

from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, ToolMessage
from langchain_core.globals import set_verbose, set_debug

from langchain.tools import tool

from langgraph.prebuilt import create_react_agent, InjectedState
from langgraph.checkpoint.memory import InMemorySaver
`;
  }

  private generateModelConfigurations(): string {
    const configs: string[] = [];
    const providerName = (this.agentInfo.model?.providerName ?? 'anthropic').toLowerCase();

    for (let i = 0; i < this.promptConfigs.length; i++) {
      const config = this.promptConfigs[i]!;
      const promptType = config.promptType ?? `CUSTOM_${i}`;

      if (promptType === 'KNOWLEDGE_BASE_RESPONSE_GENERATION' && this.knowledgeBases.length === 0) {
        continue;
      }

      const ic = config.inferenceConfiguration ?? {};
      const supportsTopK = ['anthropic', 'amazon'].includes(providerName);

      let modelKwargs = `{
        "top_p": ${ic.topP ?? 1.0},
        "temperature": ${ic.temperature ?? 0},
        "max_tokens": ${ic.maximumLength ?? 2048}`;
      if (supportsTopK) {
        modelKwargs += `,
        "top_k": ${ic.topK ?? 250},
        "stop_sequences": ${JSON.stringify(ic.stopSequences ?? [])}`;
      }
      modelKwargs += '\n    }';

      let modelConfig = `
# ${promptType} LLM configuration
llm_${promptType} = ChatBedrock(
    model_id="${this.modelId}",
    region_name="${this.agentRegion}",
    provider="${providerName}",
    model_kwargs=${modelKwargs}`;

      if (Object.keys(this.guardrailConfig).length > 0) {
        modelConfig += `,
    guardrails=${JSON.stringify(this.guardrailConfig)}`;
      }

      modelConfig += '\n)';
      configs.push(modelConfig);
    }

    // Ensure ORCHESTRATION model exists
    if (!this.promptConfigs.some(c => c.promptType === 'ORCHESTRATION')) {
      configs.push(`
llm_ORCHESTRATION = ChatBedrock(
    model_id="${this.modelId}",
    region_name="${this.agentRegion}",
    provider="${providerName}"
)`);
    }

    return configs.join('\n');
  }

  private generateKnowledgeBaseCode(): string {
    if (this.knowledgeBases.length === 0) return '';

    let code = '\n# --- Knowledge Base Tools ---\n';
    for (const kb of this.knowledgeBases) {
      const kbName = sanitizePyIdentifier(kb.name ?? '');
      const kbDescription = BaseBedrockTranslator.escapePyDoubleQuote(kb.description ?? '');
      const kbId = kb.knowledgeBaseId;
      const kbRegion = kb.knowledgeBaseArn?.split(':')[3] ?? this.agentRegion;

      code += `retriever_${kbName} = AmazonKnowledgeBasesRetriever(
    knowledge_base_id="${kbId}",
    retrieval_config={"vectorSearchConfiguration": {"numberOfResults": 5}},
    region_name="${kbRegion}"
)

retriever_tool_${kbName} = retriever_${kbName}.as_tool(name="kb_${kbName}", description="${kbDescription}")

`;
      this.tools.push(`retriever_tool_${kbName}`);
    }
    return code;
  }

  private generateCollaborationCode(collaboratorFiles: Map<string, string>): string {
    if (!this.multiAgentEnabled || this.collaborators.length === 0) return '';

    let code = '\n# --- Multi-Agent Collaboration ---\n';

    for (let i = 0; i < this.collaborators.length; i++) {
      const collaborator = this.collaborators[i]!;
      const collabName = sanitizePyIdentifier(collaborator.collaboratorName ?? '');
      const fileName = `langchain_collaborator_${collabName}`;

      // Recursively translate collaborator
      const collabTranslator = new LangGraphTranslator(collaborator as unknown as BedrockAgentConfig, this.options, {
        name: collabName,
        instruction: collaborator.collaborationInstruction ?? '',
        relayHistory: collaborator.relayConversationHistory ?? 'DISABLED',
      });
      const collabResult = collabTranslator.translate();
      collaboratorFiles.set(`${fileName}.py`, collabResult.mainPyContent);
      for (const [k, v] of collabResult.collaboratorFiles) {
        collaboratorFiles.set(k, v);
      }

      const relay = collaborator.relayConversationHistory === 'TO_COLLABORATOR';

      code += `from ${fileName} import invoke_agent as invoke_${collabName}_collaborator\n`;
      code += `
@tool
def invoke_${collabName}(query: str, state: Annotated[dict, InjectedState]) -> str:
    """Invoke the collaborator agent/specialist with the following description: ${this.collaboratorDescriptions[i]}"""
    ${relay ? 'relay_history = state.get("messages", [])[:-1]' : ''}
    invoke_agent_response = invoke_${collabName}_collaborator(query${relay ? ', relay_history' : ''})
    tools_used.update([msg.name for msg in invoke_agent_response if isinstance(msg, ToolMessage)])
    return invoke_agent_response

`;
      this.tools.push(`invoke_${collabName}`);
    }

    return code;
  }

  private generateAgentSetup(): string {
    let code = `\n# --- Agent Setup ---\ntools = [${this.tools.join(', ')}]\ntools_used = set()\n`;

    if (this.customActionGroups.length > 0) {
      code += 'tools += action_group_tools\n';
    }

    // Memory retrieval code — must match the strategies written to agentcore.json:
    // shortTerm has no strategies (no namespace-specific retrieval)
    // longAndShortTerm has SEMANTIC, USER_PREFERENCE, and SUMMARIZATION strategies
    const memoryRetrieveCode =
      this.agentcoreMemoryEnabled && this.hasLongTermStrategies
        ? `
            semantic_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f'/users/{user_id}/facts', query="Retrieve relevant facts.", actor_id=user_id, top_k=3)
            pref_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f'/users/{user_id}/preferences', query="Retrieve user preferences.", actor_id=user_id, top_k=3)
            summary_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f'/summaries/{user_id}/', query="Retrieve the most recent session summaries.", actor_id=user_id, top_k=3)
            all_memories = semantic_memories + pref_memories + summary_memories
            memory_synopsis = "\\n".join([m.get("content", {}).get("text", "") for m in all_memories])`
        : this.memoryEnabled
          ? '    memory_synopsis = ""  # TODO: Configure memory manager for local memory retrieval'
          : '';

    const memoryReplaceCode = this.memoryEnabled
      ? '    system_prompt = system_prompt.replace("$memory_synopsis$", memory_synopsis)'
      : '';

    const checkpointerLine = this.memoryEnabled ? '\n            checkpointer=checkpointer_STM,' : '';

    code += `
config = {"configurable": {"thread_id": "1"}}
set_verbose(False)
set_debug(False)

_agent = None
first_turn = True
last_input = ""
user_id = ""

# agent update loop
def get_agent():
    global _agent, user_id
    if _agent is None:
        ${memoryRetrieveCode}
        system_prompt = ORCHESTRATION_TEMPLATE
        ${memoryReplaceCode}
        _agent = create_react_agent(
            model=llm_ORCHESTRATION,
            prompt=system_prompt,
            tools=tools,${checkpointerLine}
            debug=False
        )
    return _agent
`;

    // Build invoke_agent function
    const relayParamDef = this.isAcceptingRelays ? ', relayed_messages = []' : '';
    const relayCode = this.isAcceptingRelays
      ? `if relayed_messages:
            agent.update_state(config, {"messages": relayed_messages})`
      : '';

    let preprocessCode = '';
    if (this.enabledPrompts.includes('PRE_PROCESSING')) {
      preprocessCode = `
        pre_process_output = llm_PRE_PROCESSING.invoke([SystemMessage(PRE_PROCESSING_TEMPLATE), HumanMessage(question)])
        question += "\\n<PRE_PROCESSING>{}</PRE_PROCESSING>".format(pre_process_output.content)`;
    }

    const postProcessCode = this.enabledPrompts.includes('POST_PROCESSING')
      ? `
        post_process_prompt = POST_PROCESSING_TEMPLATE.replace("$question$", question).replace("$latest_response$", response["messages"][-1].content).replace("$responses$", str(response["messages"]))
        post_process_output = llm_POST_PROCESSING.invoke([HumanMessage(post_process_prompt)])
        return [AIMessage(post_process_output.content)]`
      : `    return response['messages']`;

    code += `
def invoke_agent(question: str${relayParamDef}):
    global last_input
    last_input = question
    agent = get_agent()
    ${relayCode}
    ${preprocessCode}

    response = asyncio.run(agent.ainvoke({"messages": [{"role": "user", "content": question}]}, config))
    ${postProcessCode}
`;

    return code;
  }
}
