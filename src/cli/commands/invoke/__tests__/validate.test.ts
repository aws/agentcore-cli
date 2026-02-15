import { validateInvokeOptions } from '../validate.js';
import { describe, expect, it } from 'vitest';

describe('validateInvokeOptions', () => {
  it('returns valid with no options', () => {
    expect(validateInvokeOptions({})).toEqual({ valid: true });
  });

  it('returns valid with prompt and json', () => {
    expect(validateInvokeOptions({ json: true, prompt: 'hello' })).toEqual({ valid: true });
  });

  it('returns valid with prompt and stream', () => {
    expect(validateInvokeOptions({ stream: true, prompt: 'hello' })).toEqual({ valid: true });
  });

  it('returns invalid when json is true but no prompt', () => {
    const result = validateInvokeOptions({ json: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Prompt is required for JSON output');
  });

  it('returns invalid when stream is true but no prompt', () => {
    const result = validateInvokeOptions({ stream: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Prompt is required for streaming');
  });

  it('returns valid with prompt only', () => {
    expect(validateInvokeOptions({ prompt: 'test' })).toEqual({ valid: true });
  });

  it('returns valid with agentName and targetName', () => {
    expect(validateInvokeOptions({ agentName: 'my-agent', targetName: 'default' })).toEqual({ valid: true });
  });
});
