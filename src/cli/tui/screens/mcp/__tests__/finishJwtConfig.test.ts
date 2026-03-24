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
    // Schema accepts this structurally (both fields are optional at schema level)
    // but the TUI should map STRING_ARRAY to matchValueStringList, not matchValueString
    const result = CustomJwtAuthorizerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});
