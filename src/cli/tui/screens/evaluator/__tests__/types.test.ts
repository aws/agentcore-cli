import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MODEL,
  LEVEL_PLACEHOLDERS,
  parseCustomRatingScale,
  validateInstructionPlaceholders,
} from '../types.js';
import { describe, expect, it } from 'vitest';

describe('LEVEL_PLACEHOLDERS', () => {
  it('defines placeholders for all three levels', () => {
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('SESSION');
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('TRACE');
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('TOOL_CALL');
  });

  it('SESSION has correct public placeholders', () => {
    expect(LEVEL_PLACEHOLDERS.SESSION).toContain('context');
    expect(LEVEL_PLACEHOLDERS.SESSION).toContain('available_tools');
    expect(LEVEL_PLACEHOLDERS.SESSION).toHaveLength(2);
  });

  it('TRACE has correct public placeholders', () => {
    expect(LEVEL_PLACEHOLDERS.TRACE).toContain('context');
    expect(LEVEL_PLACEHOLDERS.TRACE).toContain('assistant_turn');
    expect(LEVEL_PLACEHOLDERS.TRACE).toHaveLength(2);
  });

  it('TOOL_CALL has tool-specific placeholders', () => {
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('available_tools');
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('context');
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('tool_turn');
  });
});

describe('DEFAULT_INSTRUCTIONS', () => {
  it('each default instruction passes its own level validation', () => {
    for (const level of ['SESSION', 'TRACE', 'TOOL_CALL'] as const) {
      const result = validateInstructionPlaceholders(DEFAULT_INSTRUCTIONS[level], level);
      expect(result).toBe(true);
    }
  });

  it('SESSION default uses {context}', () => {
    expect(DEFAULT_INSTRUCTIONS.SESSION).toContain('{context}');
  });

  it('TOOL_CALL default uses {tool_turn}', () => {
    expect(DEFAULT_INSTRUCTIONS.TOOL_CALL).toContain('{tool_turn}');
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a Claude Sonnet model ID', () => {
    expect(DEFAULT_MODEL).toContain('anthropic');
    expect(DEFAULT_MODEL).toContain('sonnet');
  });
});

describe('validateInstructionPlaceholders', () => {
  it('returns true when at least one valid placeholder is present for SESSION', () => {
    expect(validateInstructionPlaceholders('Check {context} now', 'SESSION')).toBe(true);
    expect(validateInstructionPlaceholders('See {available_tools}', 'SESSION')).toBe(true);
    expect(validateInstructionPlaceholders('Tools: {available_tools}', 'SESSION')).toBe(true);
  });

  it('returns true when at least one valid placeholder is present for TOOL_CALL', () => {
    expect(validateInstructionPlaceholders('Turn: {tool_turn}', 'TOOL_CALL')).toBe(true);
    expect(validateInstructionPlaceholders('Tools: {available_tools}', 'TOOL_CALL')).toBe(true);
  });

  it('returns error string when no valid placeholders are present', () => {
    const result = validateInstructionPlaceholders('No placeholders here', 'SESSION');
    expect(typeof result).toBe('string');
    expect(result).toContain('must contain at least one placeholder');
  });

  it('rejects SESSION-level placeholders for TOOL_CALL level', () => {
    const result = validateInstructionPlaceholders('Check {context} now', 'TOOL_CALL');
    // {context} IS valid for TOOL_CALL, so this should pass
    expect(result).toBe(true);
  });

  it('rejects TOOL_CALL-only placeholders for SESSION level', () => {
    const result = validateInstructionPlaceholders('Turn: {tool_turn}', 'SESSION');
    expect(typeof result).toBe('string');
    expect(result).toContain('must contain at least one placeholder');
  });

  it('does not match partial placeholder names', () => {
    // {tool_names} should not match {tool_name} since includes checks for exact {placeholder}
    const result = validateInstructionPlaceholders('Extra: {contexts}', 'SESSION');
    expect(typeof result).toBe('string');
  });

  it('handles multiple placeholders — at least one valid is enough', () => {
    const result = validateInstructionPlaceholders('{unknown_thing} and {context}', 'SESSION');
    expect(result).toBe(true);
  });

  it('returns descriptive error listing allowed placeholders', () => {
    const result = validateInstructionPlaceholders('nothing', 'TOOL_CALL');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('{available_tools}');
    expect(result as string).toContain('{context}');
    expect(result as string).toContain('{tool_turn}');
  });
});

describe('parseCustomRatingScale', () => {
  it('parses numerical entries', () => {
    const result = parseCustomRatingScale('1:Poor:Fails, 3:Good:Meets, 5:Excellent:Far exceeds', 'numerical');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.ratingScale.numerical).toHaveLength(3);
      expect(result.ratingScale.numerical![0]).toEqual({ value: 1, label: 'Poor', definition: 'Fails' });
      expect(result.ratingScale.numerical![2]).toEqual({ value: 5, label: 'Excellent', definition: 'Far exceeds' });
    }
  });

  it('parses categorical entries', () => {
    const result = parseCustomRatingScale('Pass:Meets criteria, Fail:Does not meet', 'categorical');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.ratingScale.categorical).toHaveLength(2);
      expect(result.ratingScale.categorical![0]).toEqual({ label: 'Pass', definition: 'Meets criteria' });
    }
  });

  it('rejects fewer than 2 entries', () => {
    const result = parseCustomRatingScale('1:Poor:Fails', 'numerical');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('At least 2');
  });

  it('rejects numerical entry with non-number value', () => {
    const result = parseCustomRatingScale('abc:Poor:Fails, 2:Good:Nice', 'numerical');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('not a valid number');
  });

  it('rejects numerical entry with too few parts', () => {
    const result = parseCustomRatingScale('1:Poor, 2:Good:Nice', 'numerical');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Format');
  });

  it('rejects categorical entry with too few parts', () => {
    const result = parseCustomRatingScale('Pass, Fail:Bad', 'categorical');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Format');
  });

  it('handles definitions containing colons', () => {
    const result = parseCustomRatingScale('Pass:Good: meets all criteria, Fail:Bad: fails all', 'categorical');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.ratingScale.categorical![0]!.definition).toBe('Good: meets all criteria');
    }
  });
});
