import { BaseError, type ErrorSource } from '../../lib/errors/types.js';
import { ErrorName } from './schemas/common-shapes.js';
import type { z } from 'zod';

type ErrorNameValue = z.infer<typeof ErrorName>;

// Maps common AWS SDK error names to a category and source.
const SDK_ERROR_MAP: Record<string, { category: ErrorNameValue; source: ErrorSource }> = {
  AccessDeniedException: { category: 'AccessDeniedError', source: 'user' },
  AccessDenied: { category: 'AccessDeniedError', source: 'user' },
  ExpiredToken: { category: 'AwsCredentialsError', source: 'user' },
  ExpiredTokenException: { category: 'AwsCredentialsError', source: 'user' },
  InvalidClientTokenId: { category: 'AwsCredentialsError', source: 'user' },
  TokenRefreshRequired: { category: 'AwsCredentialsError', source: 'user' },
  CredentialsExpired: { category: 'AwsCredentialsError', source: 'user' },
  InvalidIdentityToken: { category: 'AwsCredentialsError', source: 'user' },
  UnauthorizedAccess: { category: 'AwsCredentialsError', source: 'user' },
  ValidationException: { category: 'ValidationError', source: 'user' },
  ResourceNotFoundException: { category: 'ResourceNotFoundError', source: 'user' },
  ConflictException: { category: 'ConflictError', source: 'user' },
  ResourceAlreadyExistsException: { category: 'ConflictError', source: 'user' },
};

export function classifyError(err: unknown): { category: ErrorNameValue; source: ErrorSource } {
  if (err instanceof BaseError) {
    const parsed = ErrorName.safeParse(err.name);
    return { category: parsed.success ? parsed.data : 'UnknownError', source: err.errorSource };
  }
  if (err instanceof Error && err.name in SDK_ERROR_MAP) {
    return SDK_ERROR_MAP[err.name]!;
  }
  return { category: 'UnknownError', source: 'unknown' };
}
