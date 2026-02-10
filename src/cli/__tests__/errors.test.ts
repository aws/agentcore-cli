import {
  getErrorMessage,
  isChangesetInProgressError,
  isExpiredTokenError,
  isNoCredentialsError,
  isStackInProgressError,
} from '../errors.js';
import { describe, expect, it } from 'vitest';

describe('errors', () => {
  describe('getErrorMessage', () => {
    it('returns message from Error instance', () => {
      const err = new Error('test error');
      expect(getErrorMessage(err)).toBe('test error');
    });

    it('returns string for non-Error values', () => {
      expect(getErrorMessage('raw error')).toBe('raw error');
      expect(getErrorMessage(123)).toBe('123');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
    });
  });

  describe('isExpiredTokenError', () => {
    // Test ALL error codes in EXPIRED_TOKEN_ERROR_CODES via error.name
    const allErrorCodes = [
      'ExpiredToken',
      'ExpiredTokenException',
      'TokenRefreshRequired',
      'CredentialsExpired',
      'InvalidIdentityToken',
      'UnauthorizedAccess',
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'RequestExpired',
    ];

    it('returns true for all SDK v3 error names', () => {
      for (const code of allErrorCodes) {
        expect(isExpiredTokenError({ name: code }), `Should detect error.name: ${code}`).toBe(true);
      }
    });

    it('returns true for all error Code properties', () => {
      for (const code of allErrorCodes) {
        expect(isExpiredTokenError({ Code: code }), `Should detect error.Code: ${code}`).toBe(true);
      }
    });

    it('returns true for nested cause with error name', () => {
      expect(isExpiredTokenError({ cause: { name: 'ExpiredToken' } })).toBe(true);
    });

    it('returns true for double-nested cause', () => {
      expect(isExpiredTokenError({ cause: { cause: { name: 'ExpiredToken' } } })).toBe(true);
    });

    it('returns true for nested cause with Code', () => {
      expect(isExpiredTokenError({ cause: { Code: 'ExpiredToken' } })).toBe(true);
    });

    it('returns true for message patterns', () => {
      const patterns = [
        'expired token',
        'token has expired',
        'credentials have expired',
        'security token included in the request is expired',
        'the security token included in the request is invalid',
      ];
      for (const pattern of patterns) {
        expect(isExpiredTokenError(new Error(pattern)), `Should detect message: ${pattern}`).toBe(true);
      }
    });

    it('returns false for non-expired errors', () => {
      expect(isExpiredTokenError({ name: 'ValidationError' })).toBe(false);
      expect(isExpiredTokenError({ Code: 'ResourceNotFound' })).toBe(false);
      expect(isExpiredTokenError(new Error('some other error'))).toBe(false);
    });

    it('returns false for AccessDenied errors (authorization, not authentication)', () => {
      // AccessDenied errors indicate authorization failures (wrong account, missing IAM permissions),
      // NOT token expiration. Users should see the actual AccessDenied error, not "credentials expired".
      expect(isExpiredTokenError({ name: 'AccessDenied' })).toBe(false);
      expect(isExpiredTokenError({ name: 'AccessDeniedException' })).toBe(false);
      expect(isExpiredTokenError({ Code: 'AccessDenied' })).toBe(false);
      expect(isExpiredTokenError({ Code: 'AccessDeniedException' })).toBe(false);
      expect(isExpiredTokenError({ cause: { name: 'AccessDenied' } })).toBe(false);
      expect(isExpiredTokenError(new Error('AccessDenied: User is not authorized'))).toBe(false);
    });

    it('returns false for edge cases', () => {
      expect(isExpiredTokenError(null)).toBe(false);
      expect(isExpiredTokenError(undefined)).toBe(false);
      expect(isExpiredTokenError('string')).toBe(false);
      expect(isExpiredTokenError(123)).toBe(false);
      expect(isExpiredTokenError({})).toBe(false);
      expect(isExpiredTokenError({ name: 123 })).toBe(false); // non-string name
      expect(isExpiredTokenError({ Code: 123 })).toBe(false); // non-string Code
    });
  });

  describe('isNoCredentialsError', () => {
    it('returns true for AwsCredentialsError', () => {
      expect(isNoCredentialsError({ name: 'AwsCredentialsError' })).toBe(true);
    });

    it('returns true for message patterns', () => {
      const patterns = ['no aws credentials found', 'could not load credentials', 'credentials not found'];
      for (const pattern of patterns) {
        expect(isNoCredentialsError(new Error(pattern)), `Should detect message: ${pattern}`).toBe(true);
      }
    });

    it('returns false for other errors', () => {
      expect(isNoCredentialsError({ name: 'ExpiredTokenException' })).toBe(false);
      expect(isNoCredentialsError(new Error('some other error'))).toBe(false);
    });

    it('returns false for edge cases', () => {
      expect(isNoCredentialsError(null)).toBe(false);
      expect(isNoCredentialsError(undefined)).toBe(false);
      expect(isNoCredentialsError('string')).toBe(false);
      expect(isNoCredentialsError(123)).toBe(false);
      expect(isNoCredentialsError({})).toBe(false);
    });
  });

  describe('isStackInProgressError', () => {
    it('returns true for in-progress states', () => {
      const states = ['UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS'];
      for (const state of states) {
        expect(isStackInProgressError(new Error(`Stack is in ${state} state`)), `Should detect state: ${state}`).toBe(
          true
        );
      }
    });

    it('returns true for state and cannot be updated pattern', () => {
      expect(
        isStackInProgressError(new Error('Stack is in UPDATE_ROLLBACK_IN_PROGRESS state and cannot be updated'))
      ).toBe(true);
    });

    it('returns true for currently being updated', () => {
      expect(isStackInProgressError(new Error('stack is currently being updated'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isStackInProgressError(new Error('Stack not found'))).toBe(false);
      expect(isStackInProgressError(new Error('some other error'))).toBe(false);
    });

    it('returns false for edge cases', () => {
      expect(isStackInProgressError(null)).toBe(false);
      expect(isStackInProgressError(undefined)).toBe(false);
      expect(isStackInProgressError({})).toBe(false);
    });
  });

  describe('isChangesetInProgressError', () => {
    it('returns true for InvalidChangeSetStatus errors', () => {
      expect(
        isChangesetInProgressError(
          new Error('InvalidChangeSetStatusException: An operation on this ChangeSet is currently in progress.')
        )
      ).toBe(true);
    });

    it('returns true for changeset in progress message patterns', () => {
      expect(isChangesetInProgressError(new Error('ChangeSet is currently in progress'))).toBe(true);
      expect(isChangesetInProgressError(new Error('An operation on this changeset is currently in progress'))).toBe(
        true
      );
    });

    it('returns false for other errors', () => {
      expect(isChangesetInProgressError(new Error('Stack not found'))).toBe(false);
      expect(isChangesetInProgressError(new Error('some other error'))).toBe(false);
      expect(isChangesetInProgressError(new Error('UPDATE_IN_PROGRESS'))).toBe(false);
    });

    it('returns false for edge cases', () => {
      expect(isChangesetInProgressError(null)).toBe(false);
      expect(isChangesetInProgressError(undefined)).toBe(false);
      expect(isChangesetInProgressError({})).toBe(false);
    });
  });
});
