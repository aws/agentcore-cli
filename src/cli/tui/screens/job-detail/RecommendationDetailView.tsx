import type { RecommendationJobRecord } from '../../../operations/jobs';
import { Panel } from '../../components';
import { shortTypeName, statusColor } from './helpers';
import { Box, Text, useInput } from 'ink';
import React from 'react';

/**
 * Shared presentational detail view for a recommendation job. Renders the panel
 * body only (the caller supplies the surrounding `Screen`). Recommendation jobs
 * have no lifecycle actions, so this view is read-only.
 *
 * Back/exit semantics are caller-controlled: `backKey` is the letter that, like
 * Escape, invokes `onBack`. Flow A (`agentcore view recommendation <id>`) uses
 * `'q'` ("exit"); the TUI history flow uses `'b'` ("back to list").
 */
export function RecommendationDetailView({
  record,
  onBack,
  backKey = 'b',
  backLabel = 'back',
}: {
  record: RecommendationJobRecord;
  onBack: () => void;
  backKey?: string;
  backLabel?: string;
}) {
  useInput((input, key) => {
    if (key.escape || input === backKey) {
      onBack();
    }
  });

  const sysResult = record.result?.systemPromptRecommendationResult;
  const toolResult = record.result?.toolDescriptionRecommendationResult;
  const isFailed = record.status === 'FAILED';
  const failureText = record.failureDetail ?? record.statusReasons?.join('; ');

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Type:</Text> {shortTypeName(record.recommendationType)}
          {'  '}
          <Text bold>Agent:</Text> {record.agent}
          {'  '}
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Evaluators:</Text> {record.evaluators.join(', ') || '(none)'}
        </Text>
        {record.createdAt && (
          <Text>
            <Text bold>Created:</Text> {new Date(record.createdAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Completed:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        {isFailed && failureText && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="red">
              Failure:
            </Text>
            <Box marginLeft={2}>
              <Text color="red">{failureText}</Text>
            </Box>
          </Box>
        )}

        {sysResult?.explanation && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="yellow">
              Explanation:
            </Text>
            <Box marginLeft={2} marginTop={1}>
              <Text>{sysResult.explanation}</Text>
            </Box>
          </Box>
        )}

        {sysResult?.recommendedSystemPrompt && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">
              Recommended System Prompt:
            </Text>
            <Box marginLeft={2} marginTop={1}>
              <Text>{sysResult.recommendedSystemPrompt}</Text>
            </Box>
          </Box>
        )}

        {toolResult?.tools && toolResult.tools.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">
              Recommended Tool Descriptions:
            </Text>
            {toolResult.tools.map(tool => (
              <Box key={tool.toolName} marginTop={1} marginLeft={2} flexDirection="column">
                <Text bold>{tool.toolName}</Text>
                {tool.explanation && (
                  <Box marginTop={1}>
                    <Text color="yellow">Explanation: </Text>
                    <Text>{tool.explanation}</Text>
                  </Box>
                )}
                <Text>{tool.recommendedToolDescription}</Text>
              </Box>
            ))}
          </Box>
        )}

        {!isFailed && !sysResult?.recommendedSystemPrompt && !(toolResult?.tools && toolResult.tools.length > 0) && (
          <Box marginTop={1}>
            <Text dimColor>No recommendation results available yet.</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            Esc/{backKey.toUpperCase()} {backLabel}
          </Text>
        </Box>
      </Box>
    </Panel>
  );
}
