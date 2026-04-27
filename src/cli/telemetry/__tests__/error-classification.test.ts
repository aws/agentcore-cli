import { classifyError, isUserError } from '../error-classification';
import { describe, expect, it } from 'vitest';

function errorWithName(name: string): Error {
  const err = new Error('test');
  err.name = name;
  return err;
}

describe('classifyError', () => {
  it.each([
    ['ConfigValidationError', 'ConfigError'],
    ['ConfigNotFoundError', 'ConfigError'],
    ['ConfigReadError', 'ConfigError'],
    ['ConfigWriteError', 'ConfigError'],
    ['ConfigParseError', 'ConfigError'],
    ['AwsCredentialsError', 'CredentialsError'],
    ['AccessDeniedException', 'CredentialsError'],
    ['ExpiredToken', 'CredentialsError'],
    ['PackagingError', 'PackagingError'],
    ['MissingDependencyError', 'PackagingError'],
    ['ArtifactSizeError', 'PackagingError'],
    ['NoProjectError', 'ProjectError'],
    ['AgentAlreadyExistsError', 'ProjectError'],
    ['ResourceNotFoundException', 'ServiceError'],
    ['ValidationException', 'ServiceError'],
    ['ConflictException', 'ServiceError'],
    ['ConnectionError', 'ConnectionError'],
    ['ServerError', 'ConnectionError'],
  ] as const)('%s → %s', (errorName, expected) => {
    expect(classifyError(errorWithName(errorName))).toBe(expected);
  });

  it('returns UnknownError for unrecognized errors', () => {
    expect(classifyError(new Error('something'))).toBe('UnknownError');
  });

  it('returns UnknownError for non-Error values', () => {
    expect(classifyError('string')).toBe('UnknownError');
    expect(classifyError(null)).toBe('UnknownError');
    expect(classifyError(undefined)).toBe('UnknownError');
  });

  it('uses err.name when constructor.name is Error (SDK pattern)', () => {
    // AWS SDK errors often: new Error(); err.name = 'ValidationException'
    expect(classifyError(errorWithName('ValidationException'))).toBe('ServiceError');
  });
});

describe('isUserError', () => {
  it('returns true for user-fixable categories', () => {
    expect(isUserError(errorWithName('ConfigValidationError'))).toBe(true);
    expect(isUserError(errorWithName('AwsCredentialsError'))).toBe(true);
    expect(isUserError(errorWithName('NoProjectError'))).toBe(true);
  });

  it('returns false for system categories', () => {
    expect(isUserError(errorWithName('PackagingError'))).toBe(false);
    expect(isUserError(errorWithName('ResourceNotFoundException'))).toBe(false);
    expect(isUserError(errorWithName('ConnectionError'))).toBe(false);
    expect(isUserError(new Error('unknown'))).toBe(false);
  });
});
