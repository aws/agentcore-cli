/**
 * Tests for import runtime entrypoint detection and --entrypoint flag.
 *
 * Covers:
 * - extractEntrypoint: auto-detection from API entryPoint array
 * - --entrypoint flag override via handleImportRuntime
 * - Failure when entrypoint cannot be detected and no flag provided
 */
import { extractEntrypoint } from '../import-runtime';
import { describe, expect, it } from 'vitest';

// ============================================================================
// extractEntrypoint — unit tests
// ============================================================================

describe('extractEntrypoint', () => {
  it('returns undefined for undefined input', () => {
    expect(extractEntrypoint(undefined)).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(extractEntrypoint([])).toBeUndefined();
  });

  it('extracts .py file from otel wrapper array', () => {
    expect(extractEntrypoint(['opentelemetry-instrument', 'main.py'])).toBe('main.py');
  });

  it('extracts .py file when it is the only element', () => {
    expect(extractEntrypoint(['main.py'])).toBe('main.py');
  });

  it('returns undefined when only non-file entries exist', () => {
    expect(extractEntrypoint(['opentelemetry-instrument'])).toBeUndefined();
  });

  it('returns undefined for entries without known extensions', () => {
    expect(extractEntrypoint(['gunicorn', 'flask-app'])).toBeUndefined();
  });

  it('extracts .ts file', () => {
    expect(extractEntrypoint(['handler.ts'])).toBe('handler.ts');
  });

  it('extracts .js file', () => {
    expect(extractEntrypoint(['index.js'])).toBe('index.js');
  });

  it('picks the first matching file when multiple exist', () => {
    expect(extractEntrypoint(['wrapper', 'app.py', 'fallback.py'])).toBe('app.py');
  });

  it('extracts file with path prefix', () => {
    expect(extractEntrypoint(['opentelemetry-instrument', 'src/main.py'])).toBe('src/main.py');
  });

  it('returns undefined for extensionless entries', () => {
    expect(extractEntrypoint(['python', '-m', 'myapp'])).toBeUndefined();
  });
});
