import type { PythonRuntime } from '../../../schema/index.js';
import { PLATFORM_CANDIDATES, extractPythonVersion } from '../python.js';
import { describe, expect, it } from 'vitest';

describe('extractPythonVersion', () => {
  it('extracts 3.10 from PYTHON_3_10', () => {
    expect(extractPythonVersion('PYTHON_3_10' as PythonRuntime)).toBe('3.10');
  });

  it('extracts 3.11 from PYTHON_3_11', () => {
    expect(extractPythonVersion('PYTHON_3_11' as PythonRuntime)).toBe('3.11');
  });

  it('extracts 3.12 from PYTHON_3_12', () => {
    expect(extractPythonVersion('PYTHON_3_12' as PythonRuntime)).toBe('3.12');
  });

  it('extracts 3.13 from PYTHON_3_13', () => {
    expect(extractPythonVersion('PYTHON_3_13' as PythonRuntime)).toBe('3.13');
  });

  it('throws for unsupported runtime string', () => {
    expect(() => extractPythonVersion('RUBY_3_0' as PythonRuntime)).toThrow('Unsupported Python runtime');
  });

  it('throws for malformed runtime (missing minor)', () => {
    expect(() => extractPythonVersion('PYTHON_3' as PythonRuntime)).toThrow('Invalid Python runtime');
  });
});

describe('PLATFORM_CANDIDATES', () => {
  it('contains aarch64 manylinux platforms', () => {
    expect(PLATFORM_CANDIDATES).toHaveLength(3);
    for (const p of PLATFORM_CANDIDATES) {
      expect(p).toContain('aarch64');
      expect(p).toContain('manylinux');
    }
  });

  it('includes manylinux2014 as first candidate', () => {
    expect(PLATFORM_CANDIDATES[0]).toBe('aarch64-manylinux2014');
  });
});
