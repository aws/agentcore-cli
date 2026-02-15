import { generateUniqueName } from '../naming.js';
import { describe, expect, it } from 'vitest';

describe('generateUniqueName', () => {
  it('returns base name when no conflicts', () => {
    expect(generateUniqueName('MyAgent', [])).toBe('MyAgent');
  });

  it('returns base name when existing names are different', () => {
    expect(generateUniqueName('MyAgent', ['OtherAgent', 'ThirdAgent'])).toBe('MyAgent');
  });

  it('appends 1 when base name conflicts', () => {
    expect(generateUniqueName('MyAgent', ['MyAgent'])).toBe('MyAgent1');
  });

  it('increments counter to find unique name', () => {
    expect(generateUniqueName('MyAgent', ['MyAgent', 'MyAgent1', 'MyAgent2'])).toBe('MyAgent3');
  });

  it('uses custom separator', () => {
    expect(generateUniqueName('Agent', ['Agent'], { separator: '-' })).toBe('Agent-1');
  });

  it('increments with custom separator', () => {
    expect(generateUniqueName('Agent', ['Agent', 'Agent-1'], { separator: '-' })).toBe('Agent-2');
  });

  it('handles empty base name', () => {
    expect(generateUniqueName('', [''])).toBe('1');
  });

  it('handles empty existing names array', () => {
    expect(generateUniqueName('Agent', [])).toBe('Agent');
  });
});
