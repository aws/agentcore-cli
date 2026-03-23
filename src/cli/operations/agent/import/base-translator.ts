/**
 * Base translator for converting Bedrock Agent configurations into Python code.
 * Port of the starter toolkit's base_bedrock_translate.py.
 *
 * Generates Python code strings for action groups, KBs, multi-agent collaboration,
 * code interpreter, user input, guardrails, prompts, and memory wiring.
 */
import type {
  ActionGroupInfo,
  BedrockAgentConfig,
  BedrockAgentInfo,
  CollaboratorInfo,
  FunctionDefinition,
  KnowledgeBaseInfo,
  PromptConfiguration,
} from '../../../aws/bedrock-import-types';
import type { MemoryOption } from '../../../tui/screens/generate/types';

export interface TranslatorOptions {
  agentConfig: BedrockAgentConfig;
  enableMemory: boolean;
  memoryOption: MemoryOption;
  enableObservability: boolean;
}

export interface TranslationResult {
  mainPyContent: string;
  collaboratorFiles: Map<string, string>;
  features: ImportedFeatures;
}

export interface ImportedFeatures {
  hasMemory: boolean;
  hasKnowledgeBases: boolean;
  hasActionGroups: boolean;
  hasCodeInterpreter: boolean;
  hasMultiAgent: boolean;
  hasGuardrails: boolean;
  hasGateway: boolean;
}

/**
 * Sanitize a string to be a valid Python identifier.
 */
export function sanitizePyIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

/**
 * Base class with shared translation logic between Strands and LangChain translators.
 */
export abstract class BaseBedrockTranslator {
  protected readonly agentInfo: BedrockAgentInfo;
  protected readonly actionGroups: ActionGroupInfo[];
  protected readonly customActionGroups: ActionGroupInfo[];
  protected readonly knowledgeBases: KnowledgeBaseInfo[];
  protected readonly collaborators: CollaboratorInfo[];
  protected readonly modelId: string;
  protected readonly agentRegion: string;
  protected readonly instruction: string;
  protected readonly promptConfigs: PromptConfiguration[];
  protected readonly memoryEnabled: boolean;
  protected readonly agentcoreMemoryEnabled: boolean;
  protected readonly hasLongTermStrategies: boolean;
  protected readonly codeInterpreterEnabled: boolean;
  protected readonly userInputEnabled: boolean;
  protected readonly multiAgentEnabled: boolean;
  protected readonly supervisionType: string;
  protected readonly observabilityEnabled: boolean;
  protected readonly guardrailConfig: Record<string, string>;
  protected readonly isCollaborator: boolean;
  protected readonly isAcceptingRelays: boolean;
  protected readonly collaboratorDescriptions: string[];
  protected readonly collaboratorMap: Map<string, CollaboratorInfo>;
  protected readonly enabledPrompts: string[];
  protected readonly cleanedAgentName: string;
  protected tools: string[];

  protected importsCode: string;
  protected promptsCode: string;

  constructor(
    protected readonly config: BedrockAgentConfig,
    protected readonly options: TranslatorOptions,
    protected readonly collaboratorContext?: { name: string; instruction: string; relayHistory: string }
  ) {
    this.agentInfo = config.agent;
    this.actionGroups = (config.action_groups ?? []).filter(ag => (ag.actionGroupState ?? 'ENABLED') === 'ENABLED');
    this.customActionGroups = this.actionGroups.filter(ag => !ag.parentActionSignature);
    this.knowledgeBases = config.knowledge_bases ?? [];
    this.collaborators = config.collaborators ?? [];

    this.modelId = this.agentInfo.foundationModel ?? '';
    this.agentRegion = this.agentInfo.agentArn?.split(':')[3] ?? 'us-east-1';
    this.instruction = this.agentInfo.instruction ?? '';
    this.promptConfigs = this.agentInfo.promptOverrideConfiguration?.promptConfigurations ?? [];
    this.enabledPrompts = [];

    // Memory
    const memoryConfig = this.agentInfo.memoryConfiguration;
    this.memoryEnabled = !!memoryConfig?.enabledMemoryTypes?.length;
    this.agentcoreMemoryEnabled = options.enableMemory && this.memoryEnabled;
    this.hasLongTermStrategies = options.memoryOption === 'longAndShortTerm';

    // Features
    this.codeInterpreterEnabled = this.actionGroups.some(
      ag => ag.actionGroupName === 'codeinterpreteraction' && ag.actionGroupState === 'ENABLED'
    );
    this.userInputEnabled = this.actionGroups.some(
      ag => ag.actionGroupName === 'userinputaction' && ag.actionGroupState === 'ENABLED'
    );
    this.multiAgentEnabled =
      (this.agentInfo.agentCollaboration ?? 'DISABLED') !== 'DISABLED' && this.collaborators.length > 0;
    this.supervisionType = this.agentInfo.agentCollaboration ?? 'SUPERVISOR';
    this.observabilityEnabled = options.enableObservability;

    // Guardrails
    this.guardrailConfig = {};
    const gc = this.agentInfo.guardrailConfiguration;
    if (gc) {
      const gId =
        (gc as Record<string, string>).guardrailId ?? (gc as Record<string, string>).guardrailIdentifier ?? '';
      const gVersion = (gc as Record<string, string>).version ?? (gc as Record<string, string>).guardrailVersion ?? '';
      if (gId) {
        this.guardrailConfig = { guardrailIdentifier: gId, guardrailVersion: gVersion };
      }
    }

    // Collaboration context
    this.isCollaborator = !!collaboratorContext;
    this.isAcceptingRelays = collaboratorContext?.relayHistory === 'TO_COLLABORATOR';
    this.collaboratorDescriptions = this.collaborators.map(
      c =>
        `{'agentName': '${BaseBedrockTranslator.escapePySingleQuote(c.agent?.agentName ?? '')}', 'collaboratorName': 'invoke_${sanitizePyIdentifier(c.collaboratorName ?? '')}', 'collaboratorInstruction': '${BaseBedrockTranslator.escapePySingleQuote(c.collaborationInstruction ?? '')}'}`
    );
    this.collaboratorMap = new Map(this.collaborators.map(c => [c.collaboratorName ?? '', c]));

    this.cleanedAgentName = (this.agentInfo.agentName ?? 'agent')
      .replace(/\s/g, '_')
      .replace(/-/g, '_')
      .toLowerCase()
      .slice(0, 30);

    this.tools = [];

    // Base imports (common to both frameworks)
    this.importsCode = `# ---------- NOTE: This file is auto-generated by AgentCore CLI (Import from Bedrock Agents). ----------
# Use this agent definition as a starting point for your custom agent implementation.
# Review the generated code, evaluate agent behavior, and make necessary changes before deploying.
# -------------------------------------------------------------------------------------------------

import json, sys, os, re, io, uuid, asyncio
from typing import Union, Optional, Annotated, Dict, List, Any, Literal
from pydantic import BaseModel, Field
import boto3
from dotenv import load_dotenv

from bedrock_agentcore.runtime.context import RequestContext
from bedrock_agentcore import BedrockAgentCoreApp

load_dotenv()
`;

    if (!this.isCollaborator) {
      this.importsCode += '\napp = BedrockAgentCoreApp()\n';
    }

    this.promptsCode = '';
  }

  /**
   * Generate the full translated Python code.
   */
  abstract translate(): TranslationResult;

  /** Escape a string for use inside Python double-quoted strings. */
  static escapePyDoubleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  /** Escape a string for use inside Python single-quoted strings. */
  static escapePySingleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }

  /** Escape a string for use inside Python triple-quoted strings. */
  static escapePyTripleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  }

  /**
   * Generate prompt variable assignments for enabled prompt overrides.
   */
  protected generatePrompts(): string {
    let code = '';
    for (const config of this.promptConfigs) {
      const promptType = config.promptType ?? '';

      const template = config.basePromptTemplate?.system;
      if (!template) continue;

      this.enabledPrompts.push(promptType);

      // Inject the agent instruction into the orchestration prompt
      let processedTemplate = template;
      if (promptType === 'ORCHESTRATION') {
        processedTemplate = processedTemplate.replace('$instruction$', this.instruction);
      }

      // Escape for Python triple-quoted string
      const escaped = BaseBedrockTranslator.escapePyTripleQuote(processedTemplate);
      code += `\n${promptType}_TEMPLATE = """${escaped}"""\n`;
    }

    // Ensure ORCHESTRATION_TEMPLATE always exists
    if (!this.enabledPrompts.includes('ORCHESTRATION')) {
      const escaped = BaseBedrockTranslator.escapePyTripleQuote(this.instruction);
      code += `\nORCHESTRATION_TEMPLATE = """${escaped}"""\n`;
      this.enabledPrompts.push('ORCHESTRATION');
    }

    return code;
  }

  /**
   * Generate code for function-schema action groups (as @tool decorated functions).
   */
  protected generateFunctionActionGroupTools(): string {
    let code = '\n# --- Action Group Tools ---\naction_group_tools = []\n';

    for (const ag of this.customActionGroups) {
      if (ag.functionSchema?.functions) {
        for (const fn of ag.functionSchema.functions) {
          code += this.generateFunctionTool(fn, ag.actionGroupName);
        }
      }
    }

    return code;
  }

  private generateFunctionTool(fn: FunctionDefinition, groupName: string): string {
    const fnName = fn.name.replace(/[^a-zA-Z0-9_]/g, '_');
    const params = fn.parameters ?? {};
    const paramList = Object.entries(params)
      .map(([name, info]) => {
        const pyType =
          info.type === 'string'
            ? 'str'
            : info.type === 'integer'
              ? 'int'
              : info.type === 'number'
                ? 'float'
                : info.type === 'boolean'
                  ? 'bool'
                  : 'str';
        return `${name}: ${pyType}`;
      })
      .join(', ');

    const description = fn.description ?? `Function from action group ${groupName}`;
    const escapedDesc = BaseBedrockTranslator.escapePyTripleQuote(description);

    return `
@tool
def ${fnName}(${paramList}) -> str:
    """${escapedDesc}"""
    # TODO: Implement the logic for this action group function.
    # This was imported from Bedrock Agent action group "${BaseBedrockTranslator.escapePyDoubleQuote(groupName)}".
    return json.dumps({"status": "not_implemented", "function": "${fnName}"})

action_group_tools.append(${fnName})
`;
  }

  /**
   * Generate memory configuration code.
   */
  protected generateMemoryCode(memorySaver: string): string {
    if (!this.memoryEnabled) return '';

    let code = '\n# --- Memory Configuration ---\n';

    if (this.agentcoreMemoryEnabled) {
      code += `
from bedrock_agentcore.memory import MemoryClient

memory_client = MemoryClient()
memory_id = os.environ.get("MEMORY_ID", "")
`;
    }

    code += `checkpointer_STM = ${memorySaver}()\n`;
    return code;
  }

  /**
   * Generate the entrypoint code (@app.entrypoint pattern).
   */
  protected generateEntrypointCode(platform: 'strands' | 'langchain'): string {
    let code = '';

    if (!this.isCollaborator) {
      code += '\n@app.entrypoint\n';
    }

    const memoryEventCode = this.agentcoreMemoryEnabled
      ? `
            event = memory_client.create_event(
                memory_id=memory_id,
                actor_id=user_id,
                session_id=session_id,
                messages=formatted_messages
            )`
      : '';

    const toolsUsedUpdate =
      platform === 'strands'
        ? 'tools_used.update(list(agent_result.metrics.tool_metrics.keys()))'
        : 'tools_used.update([msg.name for msg in agent_result if isinstance(msg, ToolMessage)])';
    const responseContent = platform === 'strands' ? 'str(agent_result)' : 'agent_result[-1].content';

    const lines = ['def endpoint(payload, context):', '    try:'];
    if (this.agentcoreMemoryEnabled) {
      lines.push('        global user_id');
      lines.push('        user_id = user_id or payload.get("userId", uuid.uuid4().hex[:8])');
    }
    lines.push(
      '        session_id = context.session_id or payload.get("sessionId", uuid.uuid4().hex[:8])',
      '',
      '        tools_used.clear()',
      '        agent_query = payload.get("prompt", "")',
      '        if not agent_query:',
      "            return {'error': \"No query provided, please provide a 'prompt' field in the payload.\"}",
      '',
      '        agent_result = invoke_agent(agent_query)',
      '',
      '        ' + toolsUsedUpdate,
      '        response_content = ' + responseContent,
      '',
      '        sources = []',
      "        urls = re.findall(r'https?://[^\\s<>\"{}|\\\\^`\\[\\]]+', response_content)",
      '        source_tags = re.findall(r"<source>(.*?)</source>", response_content)',
      '        sources.extend(urls)',
      '        sources.extend(source_tags)',
      '        sources = list(set(sources))',
      '',
      '        formatted_messages = [(agent_query, "USER"), (response_content if response_content else "No Response.", "ASSISTANT")]'
    );
    if (memoryEventCode) {
      lines.push(memoryEventCode);
    }
    lines.push(
      '',
      "        return {'result': {'response': response_content, 'sources': sources, 'tools_used': list(tools_used), 'sessionId': session_id, 'messages': formatted_messages}}",
      '    except Exception as e:',
      "        return {'error': str(e)}"
    );
    code += lines.join('\n');
    return code;
  }

  /**
   * Assemble the final Python code from sections.
   */
  protected assembleCode(sections: string[]): string {
    return sections.filter(Boolean).join('\n');
  }

  /**
   * Get the imported features summary for this agent config.
   */
  protected getFeatures(): ImportedFeatures {
    return {
      hasMemory: this.memoryEnabled,
      hasKnowledgeBases: this.knowledgeBases.length > 0,
      hasActionGroups: this.customActionGroups.length > 0,
      hasCodeInterpreter: this.codeInterpreterEnabled,
      hasMultiAgent: this.multiAgentEnabled,
      hasGuardrails: Object.keys(this.guardrailConfig).length > 0,
      hasGateway: false,
    };
  }
}
