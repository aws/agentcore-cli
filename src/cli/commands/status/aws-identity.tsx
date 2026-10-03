import type { AwsIdentityStatus } from './action';
import { isAccountMismatch } from './constants';
import { Box, Text } from 'ink';

/**
 * Shows which AWS account (and profile) the active credentials resolve to, and warns
 * when it differs from the selected deployment target's account.
 */
export function AwsIdentityInfo({
  identity,
  targetName,
  targetAccount,
}: {
  identity?: AwsIdentityStatus;
  targetName?: string;
  targetAccount?: string;
}) {
  if (!identity) return null;
  const profile = identity.profile ? ` (profile: ${identity.profile})` : '';

  if (!identity.account) {
    return (
      <Text color="yellow">
        AWS account: unavailable{profile} - {identity.error}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        AWS account: {identity.account}
        {profile}
      </Text>
      {isAccountMismatch(identity, targetAccount) && (
        <Text color="yellow">
          Warning: your AWS credentials are for account {identity.account}, but target &apos;{targetName}&apos; is
          configured for account {targetAccount}.
        </Text>
      )}
    </Box>
  );
}
