import { isSensitiveKey } from '../sensitive-keys';
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
