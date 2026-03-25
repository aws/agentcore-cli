import { Panel, Screen } from '../../components';
import { useFetchAccessFlow } from './useFetchAccessFlow';
import { Box, Text, useInput } from 'ink';
import React from 'react';

interface FetchAccessScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

function authLabel(authType: string): string {
  if (authType === 'CUSTOM_JWT') return 'JWT';
  if (authType === 'AWS_IAM') return 'IAM';
  return 'Open';
}

function authColor(authType: string): string {
  if (authType === 'CUSTOM_JWT') return 'yellow';
  if (authType === 'AWS_IAM') return 'blue';
  return 'green';
}

function resourceLabel(resourceType: string): string {
  return resourceType === 'agent' ? 'Agent' : 'Gateway';
}

export function FetchAccessScreen({ isInteractive: _isInteractive, onExit }: FetchAccessScreenProps) {
  const {
    phase,
    resources,
    selectedIndex,
    selectedResource,
    result,
    error,
    tokenVisible,
    tokenMayBeExpired,
    copied,
    canGoBack,
    moveSelection,
    confirmSelection,
    toggleTokenVisibility,
    copyToken,
    refresh,
    goBackToPicker,
  } = useFetchAccessFlow();

  // Handle Esc: result/error → picker (if multiple resources), picker → home
  const handleExit = canGoBack && (phase === 'result' || phase === 'error') ? goBackToPicker : onExit;

  useInput(
    (input, key) => {
      if (phase === 'picking') {
        if (key.upArrow) moveSelection(-1);
        if (key.downArrow) moveSelection(1);
        if (key.return) confirmSelection();
      }

      if (phase === 'result') {
        if (input.toLowerCase() === 's' && result?.token) {
          toggleTokenVisibility();
        }
        if (input.toLowerCase() === 'c' && result?.token) {
          copyToken();
        }
        if (input.toLowerCase() === 'r') {
          refresh();
        }
      }

      if (phase === 'error') {
        if (input.toLowerCase() === 'r') {
          refresh();
        }
      }
    },
    { isActive: phase === 'picking' || phase === 'result' || phase === 'error' }
  );

  if (phase === 'loading') {
    return (
      <Screen title="Fetch Access" onExit={onExit}>
        <Text dimColor>Loading configuration...</Text>
      </Screen>
    );
  }

  if (phase === 'error') {
    const errorHelpParts: string[] = ['R retry', 'Esc back', 'Ctrl+C quit'];
    return (
      <Screen title="Fetch Access" onExit={handleExit} helpText={errorHelpParts.join(' · ')}>
        <Box flexDirection="column">
          <Text color="red">Error: {error}</Text>
          {canGoBack && (
            <Box marginTop={1}>
              <Text dimColor>Press R to retry or Esc to pick a different resource.</Text>
            </Box>
          )}
        </Box>
      </Screen>
    );
  }

  if (phase === 'picking') {
    return (
      <Screen title="Fetch Access" onExit={onExit} helpText="↑↓ navigate · Enter select · Esc back · Ctrl+C quit">
        <Panel title="Select a resource">
          <Box flexDirection="column">
            {resources.map((res, i) => {
              const isSelected = i === selectedIndex;
              return (
                <Box key={`${res.resourceType}-${res.name}`}>
                  <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '❯' : ' '} </Text>
                  <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                    {res.name}
                  </Text>
                  <Text dimColor> {resourceLabel(res.resourceType)}</Text>
                  <Text color={authColor(res.authType)}> [{authLabel(res.authType)}]</Text>
                </Box>
              );
            })}
          </Box>
        </Panel>
      </Screen>
    );
  }

  if (phase === 'fetching') {
    const label = selectedResource
      ? `${resourceLabel(selectedResource.resourceType).toLowerCase()} ${selectedResource.name}`
      : 'resource';
    return (
      <Screen title="Fetch Access" onExit={handleExit}>
        <Text dimColor>Fetching access for {label}...</Text>
      </Screen>
    );
  }

  // phase === 'result'
  if (!result) return null;

  const helpParts: string[] = [];
  if (result.token) {
    helpParts.push('C copy token', 'S show/hide token');
  }
  helpParts.push('R refresh', 'Esc back', 'Ctrl+C quit');
  const helpText = helpParts.join(' · ');

  const maskedToken = '•'.repeat(32);
  const resType = selectedResource ? resourceLabel(selectedResource.resourceType) : 'Resource';

  return (
    <Screen title="Fetch Access" onExit={handleExit} helpText={helpText}>
      <Box flexDirection="column">
        <Box>
          <Text bold>{resType}: </Text>
          <Text color="green">{selectedResource?.name}</Text>
        </Box>

        {result.url && (
          <Box>
            <Text bold>URL: </Text>
            <Text color="cyan">{result.url}</Text>
          </Box>
        )}

        <Box>
          <Text bold>Auth: </Text>
          <Text color={authColor(result.authType)}>{authLabel(result.authType)}</Text>
        </Box>

        {result.message && (
          <Box marginTop={1}>
            <Text dimColor>{result.message}</Text>
          </Box>
        )}

        {result.token && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold>
                Token{result.expiresIn !== undefined ? <Text dimColor> (expires in {result.expiresIn}s)</Text> : ''}:
              </Text>
              {copied && (
                <Text color="green" bold>
                  {' '}
                  Copied!
                </Text>
              )}
            </Box>
            <Box marginLeft={2}>
              <Text color={tokenVisible ? 'yellow' : undefined} dimColor={!tokenVisible}>
                {tokenVisible ? result.token : maskedToken}
              </Text>
            </Box>
            {!copied && (
              <Box marginLeft={2}>
                <Text dimColor>Press C to copy full token to clipboard</Text>
              </Box>
            )}
            {tokenMayBeExpired && (
              <Box marginTop={1}>
                <Text color="yellow">Token may have expired. Press R to refresh.</Text>
              </Box>
            )}
          </Box>
        )}

        {result.url && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Example:</Text>
            <Box marginLeft={2}>
              {result.authType === 'NONE' && <Text dimColor>{`curl ${result.url}/`}</Text>}
              {result.authType === 'AWS_IAM' && <Text dimColor>{`aws curl ${result.url}/`}</Text>}
              {result.authType === 'CUSTOM_JWT' && result.token && (
                <Text dimColor>{`curl -H "Authorization: Bearer <token>" ${result.url}/`}</Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Screen>
  );
}
