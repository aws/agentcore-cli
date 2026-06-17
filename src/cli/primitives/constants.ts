/** User-facing note included in CLI remove JSON output. */
export const SOURCE_CODE_NOTE =
  'Your agent app source code has not been modified. Deploy with `agentcore deploy` to apply your removal changes to AWS.';

/** Valid passthrough protocol types (mirrors PassthroughProtocolTypeSchema). */
export const PASSTHROUGH_PROTOCOL_TYPES = ['MCP', 'A2A', 'INFERENCE', 'CUSTOM'] as const;

/** Error shown when `--additional-params` is not parseable as a JSON object (lite_llm harness). */
export const ADDITIONAL_PARAMS_JSON_ERROR = '--additional-params must be a valid JSON object';
