import { ConfigIO } from '../../../../../lib';
import type { HarnessModel } from '../../../../../schema';
import type {
  HarnessModelConfiguration,
  HarnessSystemPrompt,
  InvokeHarnessOptions,
} from '../../../../aws/agentcore-harness';
import type { HarnessInvocationOverrides } from '../api-types';

const DEFAULT_MAX_ITERATIONS = 75;

/**
 * Map the local harness spec's model onto the invoke API's model-configuration shape, so dev
 * invocations honor agentcore.json model settings (notably maxTokens) without a redeploy. The web
 * UI only sends a model override when the user edits the model panel — without this default the
 * deployed model config silently wins. Returns undefined for an unknown provider.
 */
function buildModelOverride(specModel: HarnessModel): HarnessModelConfiguration | undefined {
  // Fields common to every provider config.
  const common = {
    modelId: specModel.modelId,
    ...(specModel.temperature !== undefined && { temperature: specModel.temperature }),
    ...(specModel.topP !== undefined && { topP: specModel.topP }),
    ...(specModel.maxTokens !== undefined && { maxTokens: specModel.maxTokens }),
  };

  switch (specModel.provider) {
    case 'bedrock':
      return { bedrockModelConfig: { ...common, ...(specModel.apiFormat && { apiFormat: specModel.apiFormat }) } };
    case 'open_ai':
      return {
        openAiModelConfig: {
          ...common,
          ...(specModel.apiKeyArn && { apiKeyArn: specModel.apiKeyArn }),
          // OpenAI accepts only 'responses' | 'chat_completions'; the schema rejects converse_stream here.
          ...(specModel.apiFormat && specModel.apiFormat !== 'converse_stream' && { apiFormat: specModel.apiFormat }),
        },
      };
    case 'gemini':
      return {
        geminiModelConfig: {
          ...common,
          ...(specModel.apiKeyArn && { apiKeyArn: specModel.apiKeyArn }),
          ...(specModel.topK !== undefined && { topK: specModel.topK }),
        },
      };
    case 'lite_llm':
      return {
        liteLlmModelConfig: {
          ...common,
          ...(specModel.apiKeyArn && { apiKeyArn: specModel.apiKeyArn }),
          ...(specModel.apiBase && { apiBase: specModel.apiBase }),
          ...(specModel.additionalParams && { additionalParams: specModel.additionalParams }),
        },
      };
    default:
      return undefined;
  }
}

/**
 * Read the model config from the local harness spec, best-effort. Returns undefined when there is
 * no config root or the spec is unreadable — the invocation then uses the deployed model config.
 */
export async function readLocalHarnessModel(
  configRoot: string | undefined,
  harnessName: string
): Promise<HarnessModel | undefined> {
  if (!configRoot) return undefined;
  try {
    const configIO = new ConfigIO({ baseDir: configRoot });
    const spec = await configIO.readHarnessSpec(harnessName);
    return spec.model;
  } catch {
    return undefined;
  }
}

export function buildInvokeOptions(
  harnessArn: string,
  region: string,
  sessionId: string,
  messages: InvokeHarnessOptions['messages'],
  overrides?: HarnessInvocationOverrides,
  specModel?: HarnessModel
): InvokeHarnessOptions {
  const opts: InvokeHarnessOptions = {
    region,
    harnessArn,
    runtimeSessionId: sessionId,
    messages,
  };

  if (overrides?.model) {
    opts.model = overrides.model;
  } else if (specModel) {
    // Default the model from the local spec so agentcore.json settings (notably maxTokens) apply in
    // dev without a redeploy. See buildModelOverride for the per-provider mapping.
    opts.model = buildModelOverride(specModel);
  }
  if (overrides?.systemPrompt) opts.systemPrompt = [{ text: overrides.systemPrompt }] as HarnessSystemPrompt;
  if (overrides?.skills) opts.skills = overrides.skills;
  if (overrides?.actorId) opts.actorId = overrides.actorId;
  opts.maxIterations = overrides?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (overrides?.maxTokens != null) opts.maxTokens = overrides.maxTokens;
  if (overrides?.timeoutSeconds != null) opts.timeoutSeconds = overrides.timeoutSeconds;
  if (overrides?.allowedTools) opts.allowedTools = overrides.allowedTools;
  if (overrides?.tools) opts.tools = overrides.tools;

  return opts;
}
