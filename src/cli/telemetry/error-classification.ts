import { type ErrorCategory } from './schemas/common-shapes.js';
import type { z } from 'zod';

type ErrorCategoryValue = z.infer<typeof ErrorCategory>;

const CONFIG_ERRORS = new Set([
  'ConfigValidationError',
  'ConfigNotFoundError',
  'ConfigReadError',
  'ConfigWriteError',
  'ConfigParseError',
  'ValidationError',
]);
const PACKAGING_ERRORS = new Set([
  'PackagingError',
  'MissingDependencyError',
  'MissingProjectFileError',
  'UnsupportedLanguageError',
  'ArtifactSizeError',
  'DependencyCheckError',
]);
const CREDENTIAL_ERRORS = new Set([
  'AwsCredentialsError',
  'AccessDeniedException',
  'AccessDenied',
  'AccessDeniedError',
  'ExpiredToken',
  'ExpiredTokenException',
  'TokenRefreshRequired',
  'CredentialsExpired',
  'InvalidIdentityToken',
  'UnauthorizedAccess',
  'InvalidClientTokenId',
]);
const PROJECT_ERRORS = new Set(['NoProjectError', 'AgentAlreadyExistsError']);
const CONNECTION_ERRORS = new Set(['ConnectionError', 'ServerError']);
const SERVICE_ERRORS = new Set([
  'ResourceNotFoundException',
  'ValidationException',
  'ConflictException',
  'ResourceAlreadyExistsException',
  'ResourceNotFoundError',
  'ConflictError',
]);

const USER_CATEGORIES = new Set<ErrorCategoryValue>(['ConfigError', 'CredentialsError', 'ProjectError']);

export function classifyError(err: unknown): ErrorCategoryValue {
  if (!(err instanceof Error)) return 'UnknownError';
  const name =
    err.constructor.name === 'Error'
      ? 'name' in err && typeof err.name === 'string'
        ? err.name
        : 'Error'
      : err.constructor.name;
  if (CONFIG_ERRORS.has(name)) return 'ConfigError';
  if (CREDENTIAL_ERRORS.has(name)) return 'CredentialsError';
  if (PACKAGING_ERRORS.has(name)) return 'PackagingError';
  if (PROJECT_ERRORS.has(name)) return 'ProjectError';
  if (SERVICE_ERRORS.has(name)) return 'ServiceError';
  if (CONNECTION_ERRORS.has(name)) return 'ConnectionError';
  return 'UnknownError';
}

export function isUserError(err: unknown): boolean {
  return USER_CATEGORIES.has(classifyError(err));
}
