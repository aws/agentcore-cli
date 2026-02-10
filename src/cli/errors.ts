/**
 * Error thrown when an agent with the same name already exists.
 */
export class AgentAlreadyExistsError extends Error {
  constructor(agentName: string) {
    super(`An agent named "${agentName}" already exists in the schema.`);
    this.name = 'AgentAlreadyExistsError';
  }
}

/**
 * Converts an unknown error to a string message.
 * Handles Error instances and other thrown values consistently.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * AWS error codes that indicate expired or invalid credentials.
 * These errors can be recovered by re-authenticating.
 */
const EXPIRED_TOKEN_ERROR_CODES = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'TokenRefreshRequired',
  'CredentialsExpired',
  'InvalidIdentityToken',
  'UnauthorizedAccess',
  // Note: AccessDenied and AccessDeniedException are intentionally NOT included here.
  // These are authorization errors (wrong account, missing IAM permissions, etc.),
  // not authentication/token expiration errors.
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'RequestExpired',
]);

/**
 * Checks if an error is due to missing AWS credentials (not configured at all).
 * Returns true for errors that indicate no credentials are available.
 */
export function isNoCredentialsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const error = err as Record<string, unknown>;

  // Check for AwsCredentialsError from account.ts
  if (error.name === 'AwsCredentialsError') {
    return true;
  }

  // Check error message for "no credentials" patterns
  const message = getErrorMessage(err).toLowerCase();
  if (
    message.includes('no aws credentials') ||
    message.includes('could not load credentials') ||
    message.includes('credentials not found')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if an error is related to expired or invalid AWS credentials.
 * Returns true for errors that can be recovered by re-authenticating.
 */
export function isExpiredTokenError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const error = err as Record<string, unknown>;

  // Check AWS SDK v3 error structure (name property)
  if (typeof error.name === 'string' && EXPIRED_TOKEN_ERROR_CODES.has(error.name)) {
    return true;
  }

  // Check AWS SDK error Code property
  if (typeof error.Code === 'string' && EXPIRED_TOKEN_ERROR_CODES.has(error.Code)) {
    return true;
  }

  // Check nested error (some AWS errors wrap the actual error)
  if (error.cause && typeof error.cause === 'object') {
    return isExpiredTokenError(error.cause);
  }

  // Check error message for specific expiration patterns
  const message = getErrorMessage(err).toLowerCase();
  if (
    message.includes('expired token') ||
    message.includes('token has expired') ||
    message.includes('credentials have expired') ||
    message.includes('security token included in the request is expired') ||
    message.includes('the security token included in the request is invalid')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if an error indicates the CloudFormation stack is in a transitional state.
 * These errors occur when trying to deploy to a stack that is currently being updated.
 */
export function isStackInProgressError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();

  // CloudFormation error patterns for in-progress stacks
  if (
    (message.includes('is in') && message.includes('state and cannot be updated')) ||
    message.includes('update_in_progress') ||
    message.includes('create_in_progress') ||
    message.includes('delete_in_progress') ||
    message.includes('rollback_in_progress') ||
    message.includes('stack is currently being updated')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if an error indicates a CloudFormation changeset operation is in progress.
 * This typically occurs when multiple deploys race and one tries to create/delete
 * a changeset while another operation is already using it.
 */
export function isChangesetInProgressError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();

  // CloudFormation changeset conflict patterns
  if (
    message.includes('invalidchangesetstatus') ||
    message.includes('changeset is currently in progress') ||
    message.includes('an operation on this changeset is currently in progress')
  ) {
    return true;
  }

  return false;
}
