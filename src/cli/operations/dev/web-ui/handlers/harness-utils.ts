import { ConfigIO } from '../../../../../lib';
import type { HarnessModel } from '../../../../../schema';
import type { HarnessSystemPrompt, InvokeHarnessOptions } from '../../../../aws/agentcore-harness';
import type { HarnessInvocationOverrides } from '../api-types';

const DEFAULT_MAX_ITERATIONS = 75;

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
  } else if (specModel?.provider === 'bedrock') {
    // The web UI only sends a model override when the user edits the model panel, so without this
    // default the deployed model config silently wins during dev. Send the local spec's Bedrock
    // model config so agentcore.json settings (notably maxTokens) apply without a redeploy.
    opts.model = {
      bedrockModelConfig: {
        modelId: specModel.modelId,
        ...(specModel.apiFormat && { apiFormat: specModel.apiFormat }),
        ...(specModel.temperature !== undefined && { temperature: specModel.temperature }),
        ...(specModel.topP !== undefined && { topP: specModel.topP }),
        ...(specModel.maxTokens !== undefined && { maxTokens: specModel.maxTokens }),
      },
    };
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
