import { Screen } from '../../components';
import { Box, Text } from 'ink';
import React from 'react';

interface CliOnlyScreenProps {
  title: string;
  description: string;
  examples: string[];
  onExit: () => void;
}

export function CliOnlyScreen({ title, description, examples, onExit }: CliOnlyScreenProps) {
  return (
    <Screen title={title} onExit={onExit}>
      <Box flexDirection="column" marginTop={1}>
        <Text>{description}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>Usage:</Text>
          {examples.map((example, i) => (
            <Text key={i} dimColor>
              {'  '}$ {example}
            </Text>
          ))}
        </Box>
      </Box>
    </Screen>
  );
}
