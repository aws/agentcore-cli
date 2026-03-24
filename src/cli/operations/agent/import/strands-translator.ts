/**
 * Strands-specific translator for Bedrock Agent import.
 * Port of the starter toolkit's bedrock_to_strands.py.
 */
import type { BedrockAgentConfig } from '../../../aws/bedrock-import-types';
import type { TranslationResult, TranslatorOptions } from './base-translator';
import { BaseBedrockTranslator, sanitizePyIdentifier } from './base-translator';

export class StrandsTranslator extends BaseBedrockTranslator {
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
    const importsCode = this.importsCode + this.generateStrandsImports();
    const promptsCode = this.generatePrompts();
    const modelsCode = this.generateModelConfigurations();
    const collaborationCode = this.generateCollaborationCode(collaboratorFiles);
    const toolsCode = this.generateFunctionActionGroupTools();
    const memoryCode = this.generateMemoryCode('SlidingWindowConversationManager');
    const kbCode = this.generateKnowledgeBaseCode();
    const agentSetupCode = this.generateAgentSetup();
    const entrypointCode = this.generateEntrypointCode('strands');

    const guardrailWarning =
      Object.keys(this.guardrailConfig).length > 0
        ? `\n# WARNING: Guardrails were configured on the Bedrock Agent but Strands SDK does not\n# natively support guardrails on BedrockModel. Consider using Bedrock Guardrails API directly.\n`
        : '';

    const mainPyContent = this.assembleCode([
      importsCode,
      guardrailWarning,
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

  private generateStrandsImports(): string {
    return `
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from strands import Agent, tool
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models import BedrockModel
from strands.types.content import Message
`;
  }

  private generateModelConfigurations(): string {
    const configs: string[] = [];

    for (let i = 0; i < this.promptConfigs.length; i++) {
      const config = this.promptConfigs[i]!;
      const promptType = config.promptType ?? `CUSTOM_${i}`;

      if (promptType === 'KNOWLEDGE_BASE_RESPONSE_GENERATION' && this.knowledgeBases.length === 0) {
        continue;
      }

      const ic = config.inferenceConfiguration ?? {};
      configs.push(`
llm_${promptType} = BedrockModel(
    model_id="${this.modelId}",
    region_name="${this.agentRegion}",
    temperature=${ic.temperature ?? 0},
    max_tokens=${ic.maximumLength ?? 2048},
    stop_sequences=${JSON.stringify(ic.stopSequences ?? [])},
    top_p=${ic.topP ?? 1.0}
)`);
    }

    // Ensure ORCHESTRATION model exists
    if (!this.promptConfigs.some(c => c.promptType === 'ORCHESTRATION')) {
      configs.push(`
llm_ORCHESTRATION = BedrockModel(
    model_id="${this.modelId}",
    region_name="${this.agentRegion}"
)`);
    }

    return configs.join('\n');
  }

  private generateKnowledgeBaseCode(): string {
    if (this.knowledgeBases.length === 0) return '';

    let code = '\n# --- Knowledge Base Tools ---\n';
    for (const kb of this.knowledgeBases) {
      const kbName = sanitizePyIdentifier(kb.name ?? '');
      const kbDescription = BaseBedrockTranslator.escapePyTripleQuote(kb.description ?? '');
      const kbId = kb.knowledgeBaseId;
      const kbRegion = kb.knowledgeBaseArn?.split(':')[3] ?? this.agentRegion;

      code += `
@tool
def retrieve_${kbName}(query: str):
    """This is a knowledge base with the following description: ${kbDescription}. Invoke it with a query to get relevant results."""
    client = boto3.client("bedrock-agent-runtime", region_name="${kbRegion}")
    return client.retrieve(
        retrievalQuery={"text": query},
        knowledgeBaseId="${kbId}",
        retrievalConfiguration={
            "vectorSearchConfiguration": {"numberOfResults": 10},
        },
    ).get('retrievalResults', [])

`;
      this.tools.push(`retrieve_${kbName}`);
    }
    return code;
  }

  private generateCollaborationCode(collaboratorFiles: Map<string, string>): string {
    if (!this.multiAgentEnabled || this.collaborators.length === 0) return '';

    let code = '\n# --- Multi-Agent Collaboration ---\n';

    for (let i = 0; i < this.collaborators.length; i++) {
      const collaborator = this.collaborators[i]!;
      const collabName = sanitizePyIdentifier(collaborator.collaboratorName ?? '');
      const fileName = `strands_collaborator_${collabName}`;

      // Recursively translate collaborator
      const collabTranslator = new StrandsTranslator(collaborator as unknown as BedrockAgentConfig, this.options, {
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
def invoke_${collabName}(query: str) -> str:
    """Invoke the collaborator agent/specialist with the following description: ${this.collaboratorDescriptions[i]}"""
    ${relay ? 'relay_history = get_agent().messages[:-2]' : ''}
    invoke_agent_response = invoke_${collabName}_collaborator(query${relay ? ', relay_history' : ''})
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
    const memoryRetrieveLines =
      this.agentcoreMemoryEnabled && this.hasLongTermStrategies
        ? [
            '        semantic_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f\'/users/{user_id}/facts\', query="Retrieve relevant facts.", actor_id=user_id, top_k=3)',
            '        pref_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f\'/users/{user_id}/preferences\', query="Retrieve user preferences.", actor_id=user_id, top_k=3)',
            '        summary_memories = memory_client.retrieve_memories(memory_id=memory_id, namespace=f\'/summaries/{user_id}/\', query="Retrieve the most recent session summaries.", actor_id=user_id, top_k=3)',
            '        all_memories = semantic_memories + pref_memories + summary_memories',
            '        memory_synopsis = "\\n".join([m.get("content", {}).get("text", "") for m in all_memories])',
          ]
        : this.memoryEnabled
          ? ['        memory_synopsis = ""  # TODO: Configure memory manager for local memory retrieval']
          : [];

    const memoryReplaceLines = this.memoryEnabled
      ? ['        system_prompt = system_prompt.replace("$memory_synopsis$", memory_synopsis)']
      : [];

    const getAgentLines = [
      '# agent update loop',
      'def get_agent():',
      '    global _agent',
      '    if _agent is None:',
      ...memoryRetrieveLines,
      '        system_prompt = ORCHESTRATION_TEMPLATE',
      ...memoryReplaceLines,
      '        _agent = Agent(',
      '            model=llm_ORCHESTRATION,',
      '            system_prompt=system_prompt,',
      '            tools=tools,',
      `            conversation_manager=${this.memoryEnabled ? 'checkpointer_STM' : 'SlidingWindowConversationManager()'}`,
      '        )',
      '    return _agent',
    ];

    code +=
      `

def make_msg(role, text):
    return {
        "role": role,
        "content": [{"text": text}]
    }

def inference(model, messages, system_prompt=""):
    async def run_inference():
        results = []
        async for event in model.stream(messages=messages, system_prompt=system_prompt):
            results.append(event)
        return results

    response = asyncio.run(run_inference())

    text = ""
    for chunk in response:
        if "contentBlockDelta" not in chunk:
            continue
        text += chunk["contentBlockDelta"].get("delta", {}).get("text", "")

    return text

_agent = None
first_turn = True
last_input = ""
user_id = ""

` +
      getAgentLines.join('\n') +
      '\n';

    // Build invoke_agent function
    const relayParamDef = this.isAcceptingRelays ? ', relayed_messages = []' : '';
    const relayLines = this.isAcceptingRelays
      ? ['    if relayed_messages:', '        agent.messages = relayed_messages']
      : [];

    const preprocessLines: string[] = [];
    if (this.enabledPrompts.includes('PRE_PROCESSING')) {
      preprocessLines.push(
        '    pre_process_output = inference(llm_PRE_PROCESSING, [make_msg("user", question)], system_prompt=PRE_PROCESSING_TEMPLATE)',
        '    question += "\\n<PRE_PROCESSING>{}</PRE_PROCESSING>".format(pre_process_output)'
      );
    }

    const postProcessCode = this.enabledPrompts.includes('POST_PROCESSING')
      ? `    post_process_prompt = POST_PROCESSING_TEMPLATE.replace("$question$", question).replace("$latest_response$", str(response)).replace("$responses$", str(agent.messages))
    post_process_output = inference(llm_POST_PROCESSING, [make_msg("user", post_process_prompt)])
    return post_process_output`
      : '    return response';

    const invokeLines = [
      `def invoke_agent(question: str${relayParamDef}):`,
      '    global last_input',
      '    last_input = question',
      '    agent = get_agent()',
      ...relayLines,
      ...preprocessLines,
      '',
      '    original_stdout = sys.stdout',
      '    sys.stdout = io.StringIO()',
      '    response = agent(question)',
      '    sys.stdout = original_stdout',
      postProcessCode,
    ];
    code += '\n' + invokeLines.join('\n') + '\n';

    return code;
  }
}
