import { ValidationError } from '../../../lib/errors/types.js';
import { validateIamRoleTrustPolicy } from '../iam';
import { describe, expect, it } from 'vitest';

const expectedPolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

describe('validateIamRoleTrustPolicy', () => {
  it('accepts structurally equal policies regardless of object key order', () => {
    const reorderedPolicy = {
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Effect: 'Allow',
        },
      ],
      Version: '2012-10-17',
    };

    expect(() =>
      validateIamRoleTrustPolicy(reorderedPolicy, expectedPolicy, 'TestRole', 'Delete the role.')
    ).not.toThrow();
  });

  it('accepts a URL-encoded matching policy', () => {
    const encodedPolicy = encodeURIComponent(JSON.stringify(expectedPolicy));

    expect(() =>
      validateIamRoleTrustPolicy(encodedPolicy, expectedPolicy, 'TestRole', 'Delete the role.')
    ).not.toThrow();
  });

  it.each([undefined, 'not-json', { ...expectedPolicy, Statement: [] }])(
    'rejects a missing, malformed, or mismatched policy',
    actualPolicy => {
      expect(() => validateIamRoleTrustPolicy(actualPolicy, expectedPolicy, 'TestRole', 'Delete the role.')).toThrow(
        ValidationError
      );
    }
  );
});
