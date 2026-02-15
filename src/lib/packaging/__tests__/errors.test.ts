import {
  ArtifactSizeError,
  MissingDependencyError,
  MissingProjectFileError,
  PackagingError,
  UnsupportedLanguageError,
} from '../errors.js';
import { describe, expect, it } from 'vitest';

describe('PackagingError', () => {
  it('sets message and name', () => {
    const err = new PackagingError('something failed');
    expect(err.message).toBe('something failed');
    expect(err.name).toBe('PackagingError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PackagingError);
  });
});

describe('MissingDependencyError', () => {
  it('formats message with binary name', () => {
    const err = new MissingDependencyError('uv');
    expect(err.message).toBe('uv is required.');
    expect(err).toBeInstanceOf(PackagingError);
  });

  it('includes install hint when provided', () => {
    const err = new MissingDependencyError('uv', 'Install from https://example.com');
    expect(err.message).toBe('uv is required. Install from https://example.com');
  });
});

describe('MissingProjectFileError', () => {
  it('formats message with file path', () => {
    const err = new MissingProjectFileError('/path/to/pyproject.toml');
    expect(err.message).toContain('/path/to/pyproject.toml');
    expect(err.message).toContain('not found');
    expect(err).toBeInstanceOf(PackagingError);
  });
});

describe('UnsupportedLanguageError', () => {
  it('formats message with language name', () => {
    const err = new UnsupportedLanguageError('Rust');
    expect(err.message).toContain('Rust');
    expect(err.message).toContain('not supported');
    expect(err).toBeInstanceOf(PackagingError);
  });
});

describe('ArtifactSizeError', () => {
  it('formats message with limit and actual size', () => {
    const limit = 250 * 1024 * 1024;
    const actual = 300 * 1024 * 1024;
    const err = new ArtifactSizeError(limit, actual);
    expect(err.message).toContain(String(limit));
    expect(err.message).toContain(String(actual));
    expect(err).toBeInstanceOf(PackagingError);
  });
});
