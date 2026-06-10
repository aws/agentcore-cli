import {
  computeDefaultCredentialEnvVarName,
  computePaymentCredentialEnvVarNames,
  computeStripePrivyCredentialEnvVarNames,
} from '../credential-utils';
import { describe, expect, it } from 'vitest';

describe('computeDefaultCredentialEnvVarName', () => {
  it('uppercases the credential name', () => {
    expect(computeDefaultCredentialEnvVarName('myCredential')).toBe('AGENTCORE_CREDENTIAL_MYCREDENTIAL');
  });

  it('converts hyphens to underscores', () => {
    expect(computeDefaultCredentialEnvVarName('my-api-key')).toBe('AGENTCORE_CREDENTIAL_MY_API_KEY');
  });

  it('handles names already containing underscores', () => {
    expect(computeDefaultCredentialEnvVarName('my_cred')).toBe('AGENTCORE_CREDENTIAL_MY_CRED');
  });

  it('handles mixed hyphens and underscores', () => {
    expect(computeDefaultCredentialEnvVarName('my-cred_name')).toBe('AGENTCORE_CREDENTIAL_MY_CRED_NAME');
  });
});

describe('computePaymentCredentialEnvVarNames', () => {
  it('returns three env var names with correct suffixes', () => {
    const result = computePaymentCredentialEnvVarNames('myMgr-conn-cdp');
    expect(result).toEqual({
      apiKeyId: 'AGENTCORE_CREDENTIAL_MYMGR_CONN_CDP_API_KEY_ID',
      apiKeySecret: 'AGENTCORE_CREDENTIAL_MYMGR_CONN_CDP_API_KEY_SECRET',
      walletSecret: 'AGENTCORE_CREDENTIAL_MYMGR_CONN_CDP_WALLET_SECRET',
    });
  });

  it('converts hyphens to underscores in prefix', () => {
    const result = computePaymentCredentialEnvVarNames('a-b-c');
    expect(result.apiKeyId).toBe('AGENTCORE_CREDENTIAL_A_B_C_API_KEY_ID');
  });
});

describe('computeStripePrivyCredentialEnvVarNames', () => {
  it('returns four env var names with correct suffixes', () => {
    const result = computeStripePrivyCredentialEnvVarNames('mgr-conn-stripe-privy');
    expect(result).toEqual({
      appId: 'AGENTCORE_CREDENTIAL_MGR_CONN_STRIPE_PRIVY_APP_ID',
      appSecret: 'AGENTCORE_CREDENTIAL_MGR_CONN_STRIPE_PRIVY_APP_SECRET',
      authorizationPrivateKey: 'AGENTCORE_CREDENTIAL_MGR_CONN_STRIPE_PRIVY_AUTHORIZATION_PRIVATE_KEY',
      authorizationId: 'AGENTCORE_CREDENTIAL_MGR_CONN_STRIPE_PRIVY_AUTHORIZATION_ID',
    });
  });

  it('handles name with no hyphens', () => {
    const result = computeStripePrivyCredentialEnvVarNames('simple');
    expect(result.appId).toBe('AGENTCORE_CREDENTIAL_SIMPLE_APP_ID');
    expect(result.appSecret).toBe('AGENTCORE_CREDENTIAL_SIMPLE_APP_SECRET');
    expect(result.authorizationPrivateKey).toBe('AGENTCORE_CREDENTIAL_SIMPLE_AUTHORIZATION_PRIVATE_KEY');
    expect(result.authorizationId).toBe('AGENTCORE_CREDENTIAL_SIMPLE_AUTHORIZATION_ID');
  });
});
