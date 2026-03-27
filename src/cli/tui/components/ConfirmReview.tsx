import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface ConfirmField {
  label: string;
  value: string | ReactNode;
}

interface ConfirmReviewProps {
  /** Title displayed at the top (default: "Review Configuration") */
  title?: string;
  /** Array of label-value pairs to display */
  fields: ConfirmField[];
  /** Custom help text (default: "Enter confirm · Esc back") */
  helpText?: string;
}

/**
 * Reusable confirmation/review component for wizard flows.
 * Displays a list of label-value pairs with consistent styling.
 *
 * @example
 * ```tsx
 * <ConfirmReview
 *   fields={[
 *     { label: 'Name', value: config.name },
 *     { label: 'Type', value: 'API Key' },
 *     { label: 'Agents', value: config.runtimes.join(', ') || 'None' },
 *   ]}
 * />
 * ```
 */
export function ConfirmReview({
  title = 'Review Configuration',
  fields,
  helpText = 'Enter confirm · Esc back',
}: ConfirmReviewProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {fields.map((field, idx) => (
          <Text key={idx}>
            <Text dimColor>{field.label}: </Text>
            {typeof field.value === 'string' ? <Text>{field.value}</Text> : field.value}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{helpText}</Text>
      </Box>
    </Box>
  );
}
