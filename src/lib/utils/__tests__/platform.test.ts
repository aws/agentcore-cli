import { getVenvExecutable } from '../platform.js';
import { describe, expect, it } from 'vitest';

describe('getVenvExecutable', () => {
  it('returns bin path on unix', () => {
    const result = getVenvExecutable('.venv', 'python');
    expect(result).toContain('python');
    expect(result).toMatch(/\.venv/);
  });

  it('includes executable name in path', () => {
    const result = getVenvExecutable('/path/to/.venv', 'uvicorn');
    expect(result).toContain('uvicorn');
  });
});
