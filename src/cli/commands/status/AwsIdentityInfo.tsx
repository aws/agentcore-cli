import { type AwsIdentityStatus, isAccountMismatch } from './aws-identity';
import { Box, Text } from 'ink';

function describeCredentialSource(identity: AwsIdentityStatus): string {
  if (identity.fromEnvironment) return ' (credentials from environment variables)';
  return identity.profile ? ` (profile: ${identity.profile})` : '';
}

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
  const source = describeCredentialSource(identity);

  if (!identity.success) {
    return (
      <Text color="yellow">
        AWS account: unavailable{source} - {identity.error}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        AWS account: {identity.account}
        {source}
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
