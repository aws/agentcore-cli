import { normalizeParameterDescription, parseHelp } from './extract-cli-model.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('parseHelp preserves wrapped argument and option descriptions', () => {
  const parsed = parseHelp(`Usage: agentcore invoke [options] [prompt]

Invoke an agent.

Arguments:
  prompt                 Prompt to send to the agent. Also accepts piped
                         stdin when no prompt is provided

Options:
  --prompt-file <path>   Read the prompt from a file (for long or
                         structured payloads that exceed shell limits)

Output
  --json                 Output as JSON
`);

  assert.equal(
    parsed.args[0].description,
    'Prompt to send to the agent. Also accepts piped stdin when no prompt is provided'
  );
  assert.equal(
    parsed.options[0].description,
    'Read the prompt from a file (for long or structured payloads that exceed shell limits)'
  );
  assert.equal(parsed.options[1].description, 'Output as JSON');
});

test('normalizeParameterDescription expands model provider and LiteLLM fragments', () => {
  assert.equal(
    normalizeParameterDescription('bedrock, open_ai, or gemini'),
    'The model provider. Valid values: `bedrock`, `open_ai`, or `gemini`.'
  );
  assert.equal(
    normalizeParameterDescription('Override LiteLLM API base URL (harness only, lite_llm) [non-interactive]'),
    'The LiteLLM API base URL override for harness invocations. ' +
      'Available only with `lite_llm` in non-interactive mode.'
  );
});
