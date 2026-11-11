/**
 * Where each model provider lists the model IDs it accepts. Every place that
 * asks for a model ID links here, so users can pick a model without already
 * knowing its exact ID.
 */
export const MODEL_DOCS_URLS = {
  bedrock: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/models",
  open_ai: "https://developers.openai.com/api/docs/models/all",
  gemini: "https://ai.google.dev/gemini-api/docs/models",
  lite_llm: "https://docs.litellm.ai/docs/providers",
  open_responses: "https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html",
} as const;

export type ModelDocsProvider = keyof typeof MODEL_DOCS_URLS;

/** A model ID field's help text: what to enter, then where to find IDs. */
export function modelIdHelp(provider: ModelDocsProvider, what: string): string {
  return `${what}\nmodel IDs: ${MODEL_DOCS_URLS[provider]}`;
}
