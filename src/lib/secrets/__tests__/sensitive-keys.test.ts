import { isSensitiveKey, validateCredentialNameEncryptable } from '../sensitive-keys';
import { describe, expect, it } from 'vitest';

describe('isSensitiveKey', () => {
  it.each([
    'AGENTCORE_CREDENTIAL_MGR_CONN_API_KEY_SECRET',
    'AGENTCORE_CREDENTIAL_MGR_CONN_WALLET_SECRET',
    'AGENTCORE_CREDENTIAL_MGR_CONN_AUTHORIZATION_PRIVATE_KEY',
    'AGENTCORE_CREDENTIAL_MGR_CONN_APP_SECRET',
    'AGENTCORE_CREDENTIAL_GW_CLIENT_SECRET',
    'SOME_API_KEY',
    'AGENTCORE_CREDENTIAL_MYMODELKEY', // bare model-provider key
  ])('treats %s as sensitive', key => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'AGENTCORE_CREDENTIAL_MGR_CONN_API_KEY_ID',
    'AGENTCORE_CREDENTIAL_MGR_CONN_APP_ID',
    'AGENTCORE_CREDENTIAL_MGR_CONN_AUTHORIZATION_ID',
    'AGENTCORE_CREDENTIAL_GW_CLIENT_ID',
    'SOME_RANDOM_CONFIG',
    'PORT',
  ])('treats %s as non-sensitive', key => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('validateCredentialNameEncryptable', () => {
  it.each([
    'my-client-id', // → AGENTCORE_CREDENTIAL_MY_CLIENT_ID
    'my_client_id',
    'foo-api-key-id',
    'thing-app-id',
    'x-authorization-id',
    'PROD_CLIENT_ID',
  ])('rejects a name that normalizes to a reserved reference suffix: %s', name => {
    const result = validateCredentialNameEncryptable(name);
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/would not be encrypted at rest/i);
  });

  it.each(['my-openai-key', 'anthropic', 'gemini', 'my-secret', 'client-id-prod', 'idle', 'rapid'])(
    'accepts a safe name: %s',
    name => {
      // includes tricky non-collisions: 'client-id-prod' does not END in the suffix;
      // 'idle'/'rapid' merely contain "id" but do not end in a reference suffix.
      expect(validateCredentialNameEncryptable(name)).toBe(true);
    }
  );
});
