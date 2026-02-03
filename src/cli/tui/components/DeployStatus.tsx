import type { DeployMessage } from '../../cdk/toolkit-lib';
import { GradientText } from './StepProgress';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface DeployStatusProps {
  messages: DeployMessage[];
  isComplete: boolean;
  hasError: boolean;
}

const PROGRESS_BAR_WIDTH = 20;

// CDK message code for resource events
const CDK_CODE_RESOURCE_EVENT = 'CDK_TOOLKIT_I5502';

/**
 * Extract resource progress from messages.
 * Progress is pre-extracted at the source (in createSwitchableIoHost).
 */
function extractProgress(messages: DeployMessage[]): { current: number; total: number } | null {
  // Search from end to find most recent message with progress
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.progress) {
      return { current: msg.progress.completed, total: msg.progress.total };
    }
  }
  return null;
}

/**
 * Progress bar component.
 */
function ProgressBar({ current, total }: { current: number; total: number }) {
  const percent = total > 0 ? current / total : 0;
  const filled = Math.round(percent * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;

  return (
    <Box>
      <Text color="cyan">[</Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text color="cyan">]</Text>
      <Text>
        {' '}
        {current}/{total}
      </Text>
    </Box>
  );
}

type ResourceStatus =
  | 'CREATE_IN_PROGRESS'
  | 'CREATE_COMPLETE'
  | 'CREATE_FAILED'
  | 'UPDATE_IN_PROGRESS'
  | 'UPDATE_COMPLETE'
  | 'UPDATE_FAILED'
  | 'DELETE_IN_PROGRESS'
  | 'DELETE_COMPLETE'
  | 'DELETE_FAILED';

interface ParsedResource {
  resourceType: string;
  status: ResourceStatus;
}

/**
 * Get color for a resource status.
 */
function getStatusColor(status: ResourceStatus): string | undefined {
  if (status.endsWith('_COMPLETE')) return 'green';
  if (status.endsWith('_FAILED')) return 'red';
  if (status.endsWith('_IN_PROGRESS')) return 'cyan';
  return undefined;
}

/**
 * Extract resource type and status from a CDK resource event message.
 * Only processes I5502 (resource event) messages.
 */
function parseResourceMessage(msg: DeployMessage): ParsedResource | null {
  // Only process resource event messages
  if (msg.code !== CDK_CODE_RESOURCE_EVENT) {
    return null;
  }

  const text = msg.message;

  // Skip CLEANUP messages - they're confusing
  if (text.includes('CLEANUP')) {
    return null;
  }

  // Format: "StackName | STATUS | AWS::Service::Resource | LogicalId"
  const resourceMatch = /(AWS::\S+)/.exec(text);
  const statusMatch =
    /(CREATE_IN_PROGRESS|CREATE_COMPLETE|CREATE_FAILED|UPDATE_IN_PROGRESS|UPDATE_COMPLETE|UPDATE_FAILED|DELETE_IN_PROGRESS|DELETE_COMPLETE|DELETE_FAILED)/.exec(
      text
    );

  if (resourceMatch?.[1] && statusMatch) {
    const shortType = resourceMatch[1].replace(/^AWS::/, '');
    return { resourceType: shortType, status: statusMatch[1] as ResourceStatus };
  }

  return null;
}

/**
 * Render a resource line with color-coded status.
 */
function ResourceLine({ resource }: { resource: ParsedResource }) {
  const color = getStatusColor(resource.status);

  return (
    <Text color={color}>
      {resource.resourceType} {resource.status}
    </Text>
  );
}

/**
 * Deploy status component showing deployment progress in a contained box.
 * During deployment: shows last N resource events (type + status only)
 * After completion: shows success/failure state
 */
export function DeployStatus({ messages, isComplete, hasError }: DeployStatusProps) {
  // Parse and filter messages to only meaningful resource updates
  const parsedResources = messages
    .map(msg => ({ original: msg, parsed: parseResourceMessage(msg) }))
    .filter((m): m is { original: DeployMessage; parsed: ParsedResource } => m.parsed !== null)
    .slice(-8);

  // Extract progress for the bar
  const progress = useMemo(() => extractProgress(messages), [messages]);

  // When complete, show final status
  if (isComplete) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={hasError ? 'red' : 'green'}
        paddingX={1}
        minWidth={50}
      >
        <Text bold color={hasError ? 'red' : 'green'}>
          {hasError ? '✗ Deploy to AWS Failed' : '✓ Deploy to AWS Complete'}
        </Text>
        {progress && (
          <Box marginTop={1}>
            <ProgressBar current={progress.total} total={progress.total} />
          </Box>
        )}
        {hasError && (
          <Box flexDirection="column" marginTop={1}>
            {parsedResources.slice(-3).map((m, i) => (
              <ResourceLine key={`${m.original.code}-${i}`} resource={m.parsed} />
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} minWidth={50}>
      <GradientText text="Deploying to AWS" />
      {progress && (
        <Box marginTop={1}>
          <ProgressBar current={progress.current} total={progress.total} />
        </Box>
      )}
      {parsedResources.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {parsedResources.map((m, i) => (
            <ResourceLine key={`${m.original.code}-${i}`} resource={m.parsed} />
          ))}
        </Box>
      )}
    </Box>
  );
}
