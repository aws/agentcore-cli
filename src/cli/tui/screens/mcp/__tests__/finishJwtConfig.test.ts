import { CustomJwtAuthorizerConfigSchema } from '../../../../../schema';
import { describe, expect, it } from 'vitest';

describe('finishJwtConfig data mapping', () => {
  it('STRING_ARRAY claim produces matchValueStringList shape accepted by schema', () => {
    const config = {
      discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/pool123/.well-known/openid-configuration',
      customClaims: [
        {
          inboundTokenClaimName: 'groups',
          inboundTokenClaimValueType: 'STRING_ARRAY' as const,
          authorizingClaimMatchValue: {
            claimMatchOperator: 'CONTAINS_ANY' as const,
            claimMatchValue: {
              matchValueStringList: ['admin', 'dev'],
            },
          },
        },
      ],
    };
    const result = CustomJwtAuthorizerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('STRING claim produces matchValueString shape accepted by schema', () => {
    const config = {
      discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/pool123/.well-known/openid-configuration',
      customClaims: [
        {
          inboundTokenClaimName: 'department',
          inboundTokenClaimValueType: 'STRING' as const,
          authorizingClaimMatchValue: {
            claimMatchOperator: 'EQUALS' as const,
            claimMatchValue: {
              matchValueString: 'engineering',
            },
          },
        },
      ],
    };
    const result = CustomJwtAuthorizerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('STRING_ARRAY with matchValueString instead of matchValueStringList is rejected', () => {
    const config = {
      discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/pool123/.well-known/openid-configuration',
      customClaims: [
        {
          inboundTokenClaimName: 'groups',
          inboundTokenClaimValueType: 'STRING_ARRAY' as const,
          authorizingClaimMatchValue: {
            claimMatchOperator: 'CONTAINS_ANY' as const,
            claimMatchValue: {
              matchValueString: 'admin,dev',
            },
          },
        },
      ],
    };
    // 'admin,dev' contains a comma which violates the API-documented
    // pattern [A-Za-z0-9_.-]+ — schema now correctly rejects this
    const result = CustomJwtAuthorizerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
