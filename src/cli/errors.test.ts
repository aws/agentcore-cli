import { describe, it } from 'bun:test';
import assert from 'node:assert';
import {
  getErrorMessage,
  isExpiredTokenError,
  isNoCredentialsError,
  isStackInProgressError,
} from './errors.js';

describe('errors', () => {
  describe('getErrorMessage', () => {
    it('returns message from Error instance', () => {
      const err = new Error('test error');
      assert.strictEqual(getErrorMessage(err), 'test error');
    });

    it('returns string for non-Error values', () => {
      assert.strictEqual(getErrorMessage('raw error'), 'raw error');
      assert.strictEqual(getErrorMessage(123), '123');
      assert.strictEqual(getErrorMessage(null), 'null');
      assert.strictEqual(getErrorMessage(undefined), 'undefined');
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
      'AccessDenied',
      'AccessDeniedException',
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'RequestExpired',
    ];

    it('returns true for all SDK v3 error names', () => {
      for (const code of allErrorCodes) {
        assert.strictEqual(
          isExpiredTokenError({ name: code }),
          true,
          `Should detect error.name: ${code}`
        );
      }
    });

    it('returns true for all error Code properties', () => {
      for (const code of allErrorCodes) {
        assert.strictEqual(
          isExpiredTokenError({ Code: code }),
          true,
          `Should detect error.Code: ${code}`
        );
      }
    });

    it('returns true for nested cause with error name', () => {
      assert.strictEqual(isExpiredTokenError({ cause: { name: 'ExpiredToken' } }), true);
    });

    it('returns true for double-nested cause', () => {
      assert.strictEqual(isExpiredTokenError({ cause: { cause: { name: 'ExpiredToken' } } }), true);
    });

    it('returns true for nested cause with Code', () => {
      assert.strictEqual(isExpiredTokenError({ cause: { Code: 'AccessDenied' } }), true);
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
        assert.strictEqual(
          isExpiredTokenError(new Error(pattern)),
          true,
          `Should detect message: ${pattern}`
        );
      }
    });

    it('returns false for non-expired errors', () => {
      assert.strictEqual(isExpiredTokenError({ name: 'ValidationError' }), false);
      assert.strictEqual(isExpiredTokenError({ Code: 'ResourceNotFound' }), false);
      assert.strictEqual(isExpiredTokenError(new Error('some other error')), false);
    });

    it('returns false for edge cases', () => {
      assert.strictEqual(isExpiredTokenError(null), false);
      assert.strictEqual(isExpiredTokenError(undefined), false);
      assert.strictEqual(isExpiredTokenError('string'), false);
      assert.strictEqual(isExpiredTokenError(123), false);
      assert.strictEqual(isExpiredTokenError({}), false);
      assert.strictEqual(isExpiredTokenError({ name: 123 }), false); // non-string name
      assert.strictEqual(isExpiredTokenError({ Code: 123 }), false); // non-string Code
    });
  });

  describe('isNoCredentialsError', () => {
    it('returns true for AwsCredentialsError', () => {
      assert.strictEqual(isNoCredentialsError({ name: 'AwsCredentialsError' }), true);
    });

    it('returns true for message patterns', () => {
      const patterns = [
        'no aws credentials found',
        'could not load credentials',
        'credentials not found',
      ];
      for (const pattern of patterns) {
        assert.strictEqual(
          isNoCredentialsError(new Error(pattern)),
          true,
          `Should detect message: ${pattern}`
        );
      }
    });

    it('returns false for other errors', () => {
      assert.strictEqual(isNoCredentialsError({ name: 'ExpiredTokenException' }), false);
      assert.strictEqual(isNoCredentialsError(new Error('some other error')), false);
    });

    it('returns false for edge cases', () => {
      assert.strictEqual(isNoCredentialsError(null), false);
      assert.strictEqual(isNoCredentialsError(undefined), false);
      assert.strictEqual(isNoCredentialsError('string'), false);
      assert.strictEqual(isNoCredentialsError(123), false);
      assert.strictEqual(isNoCredentialsError({}), false);
    });
  });

  describe('isStackInProgressError', () => {
    it('returns true for in-progress states', () => {
      const states = [
        'UPDATE_IN_PROGRESS',
        'CREATE_IN_PROGRESS',
        'DELETE_IN_PROGRESS',
        'ROLLBACK_IN_PROGRESS',
      ];
      for (const state of states) {
        assert.strictEqual(
          isStackInProgressError(new Error(`Stack is in ${state} state`)),
          true,
          `Should detect state: ${state}`
        );
      }
    });

    it('returns true for state and cannot be updated pattern', () => {
      assert.strictEqual(
        isStackInProgressError(new Error('Stack is in UPDATE_ROLLBACK_IN_PROGRESS state and cannot be updated')),
        true
      );
    });

    it('returns true for currently being updated', () => {
      assert.strictEqual(isStackInProgressError(new Error('stack is currently being updated')), true);
    });

    it('returns false for other errors', () => {
      assert.strictEqual(isStackInProgressError(new Error('Stack not found')), false);
      assert.strictEqual(isStackInProgressError(new Error('some other error')), false);
    });

    it('returns false for edge cases', () => {
      assert.strictEqual(isStackInProgressError(null), false);
      assert.strictEqual(isStackInProgressError(undefined), false);
      assert.strictEqual(isStackInProgressError({}), false);
    });
  });
});
