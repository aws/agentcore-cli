import { type AwsIdentityStatus, isAccountMismatch } from './aws-identity';
import { Box, Text } from 'ink';

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

  if (!identity.success) {
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
