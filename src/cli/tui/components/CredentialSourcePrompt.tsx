import { Panel } from './Panel';
import { ScreenLayout } from './ScreenLayout';
import { SecretInput } from './SecretInput';
import { SelectList, type SelectableItem } from './SelectList';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

export type CredentialSource = 'env-local' | 'manual' | 'skip';

interface IdentityCredential {
  providerName: string;
  envVarName: string;
}

interface CredentialSourcePromptProps {
  /** List of identity providers that need API keys */
  missingCredentials: IdentityCredential[];
  /** Called when user selects to use .env.local credentials */
  onUseEnvLocal: () => void;
  /** Called when user enters credentials manually */
  onManualEntry: (credentials: Record<string, string>) => void;
  /** Called when user chooses to skip */
  onSkip: () => void;
}

const SOURCE_OPTIONS: SelectableItem[] = [
  {
    id: 'env-local',
    title: 'Use credentials from .env.local',
  },
  {
    id: 'manual',
    title: 'Enter credentials manually',
    description: 'Not saved to disk',
  },
  {
    id: 'skip',
    title: 'Skip for now',
  },
];

/**
 * Credential source selection prompt for deploy flow.
 * Allows user to choose how to provide API keys for identity providers.
 */
export function CredentialSourcePrompt({
  missingCredentials,
  onUseEnvLocal,
  onManualEntry,
  onSkip,
}: CredentialSourcePromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<'select' | 'manual-entry'>('select');
  const [manualCredentials, setManualCredentials] = useState<Record<string, string>>({});
  const [currentCredentialIndex, setCurrentCredentialIndex] = useState(0);
  const submittedRef = useRef(false);

  // Submit manual credentials when all collected (avoids setState during render)
  useEffect(() => {
    if (phase === 'manual-entry' && currentCredentialIndex >= missingCredentials.length && !submittedRef.current) {
      submittedRef.current = true;
      onManualEntry(manualCredentials);
    }
  }, [phase, currentCredentialIndex, missingCredentials.length, manualCredentials, onManualEntry]);

  useInput((input, key) => {
    if (phase !== 'select') return;

    if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : SOURCE_OPTIONS.length - 1));
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < SOURCE_OPTIONS.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const selectedOption = SOURCE_OPTIONS[selectedIndex];
      if (selectedOption?.id === 'env-local') {
        onUseEnvLocal();
      } else if (selectedOption?.id === 'manual') {
        setPhase('manual-entry');
      } else if (selectedOption?.id === 'skip') {
        onSkip();
      }
    }
  });

  // Manual entry phase - collect each credential one by one
  if (phase === 'manual-entry') {
    const currentCredential = missingCredentials[currentCredentialIndex];
    if (!currentCredential || currentCredentialIndex >= missingCredentials.length) {
      // All credentials collected - use effect to submit to avoid setState during render
      return null;
    }

    const handleSubmit = (value: string) => {
      setManualCredentials(prev => ({
        ...prev,
        [currentCredential.envVarName]: value,
      }));
      setCurrentCredentialIndex(prev => prev + 1);
    };

    const handleCancel = () => {
      // Go back to selection
      setPhase('select');
      setManualCredentials({});
      setCurrentCredentialIndex(0);
      submittedRef.current = false;
    };

    return (
      <ScreenLayout>
        <Panel>
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Enter API Key ({currentCredentialIndex + 1}/{missingCredentials.length})
            </Text>
            <Text>
              Provider: <Text color="cyan">{currentCredential.providerName}</Text>
            </Text>
            <SecretInput
              key={currentCredential.envVarName}
              prompt="API Key"
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              customValidation={value => value.trim().length > 0 || 'API key is required'}
              revealChars={4}
            />
          </Box>
        </Panel>
      </ScreenLayout>
    );
  }

  // Selection phase
  return (
    <ScreenLayout>
      <Panel>
        <Box flexDirection="column" gap={1}>
          <Text bold>Identity Provider Setup</Text>
          <Text dimColor>
            {missingCredentials.length} identity provider{missingCredentials.length > 1 ? 's' : ''} configured:
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            {missingCredentials.map(cred => (
              <Text key={cred.envVarName} dimColor>
                • {cred.providerName}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>How would you like to provide the API keys?</Text>
          </Box>
          <Box marginTop={1}>
            <SelectList items={SOURCE_OPTIONS} selectedIndex={selectedIndex} />
          </Box>
          <Text dimColor>↑↓ navigate · Enter select</Text>
        </Box>
      </Panel>
    </ScreenLayout>
  );
}
