import { TextInput } from '../../components';
import type { GroundTruthData } from './useRunEvalWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type Section = 'assertions' | 'trajectory' | 'response';

const SECTIONS: Section[] = ['assertions', 'trajectory', 'response'];

interface GroundTruthFormProps {
  sessionId: string;
  onSubmit: (gt: GroundTruthData) => void;
  onCancel: () => void;
}

export function GroundTruthForm({ sessionId, onSubmit, onCancel }: GroundTruthFormProps) {
  const [section, setSection] = useState<Section>('assertions');
  const [assertions, setAssertions] = useState<string[]>([]);
  const [trajectory, setTrajectory] = useState<string[]>([]);
  const [response, setResponse] = useState('');

  const assertionsRef = useRef(assertions);
  const trajectoryRef = useRef(trajectory);
  useEffect(() => {
    assertionsRef.current = assertions;
  }, [assertions]);
  useEffect(() => {
    trajectoryRef.current = trajectory;
  }, [trajectory]);

  const sectionIndex = SECTIONS.indexOf(section);

  const advanceSection = useCallback(() => {
    const next = SECTIONS[sectionIndex + 1];
    if (next) {
      setSection(next);
    }
  }, [sectionIndex]);

  const goBackSection = useCallback(() => {
    const prev = SECTIONS[sectionIndex - 1];
    if (prev) {
      setSection(prev);
    } else {
      onCancel();
    }
  }, [sectionIndex, onCancel]);

  // Assertions: Enter on non-empty adds item, Enter on empty advances to trajectory
  const handleAssertionSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        setAssertions(prev => [...prev, trimmed]);
      } else {
        advanceSection();
      }
    },
    [advanceSection]
  );

  // Trajectory: Enter on non-empty adds item, Enter on empty advances to response
  const handleTrajectorySubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        setTrajectory(prev => [...prev, trimmed]);
      } else {
        advanceSection();
      }
    },
    [advanceSection]
  );

  // Response: Enter submits the entire form
  const handleResponseSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      setResponse(trimmed);
      onSubmit({
        assertions: assertionsRef.current,
        expectedTrajectory: trajectoryRef.current,
        expectedResponse: trimmed,
      });
    },
    [onSubmit]
  );

  return (
    <Box flexDirection="column">
      <Text>
        Session: <Text dimColor>{sessionId}</Text>
      </Text>
      <Text dimColor>All fields are optional. Press Enter on empty to skip to next section.</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold={section === 'assertions'}>Assertions:</Text>
        {assertions.length === 0 && section !== 'assertions' && <Text dimColor> (none)</Text>}
        {assertions.map((a, i) => (
          <Text key={i}>
            {'  '}
            {i + 1}. {a}
          </Text>
        ))}
        {section === 'assertions' && (
          <TextInput
            key={`a-${assertions.length}`}
            prompt=""
            initialValue=""
            allowEmpty
            onSubmit={handleAssertionSubmit}
            onCancel={goBackSection}
          />
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold={section === 'trajectory'}>Expected trajectory:</Text>
        {trajectory.length === 0 && section !== 'trajectory' && <Text dimColor> (none)</Text>}
        {trajectory.map((t, i) => (
          <Text key={i}>
            {'  '}
            {i + 1}. {t}
          </Text>
        ))}
        {section === 'trajectory' && (
          <TextInput
            key={`t-${trajectory.length}`}
            prompt=""
            initialValue=""
            allowEmpty
            onSubmit={handleTrajectorySubmit}
            onCancel={goBackSection}
          />
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold={section === 'response'}>Expected response (targets last trace):</Text>
        {section !== 'response' && !response && <Text dimColor> (none)</Text>}
        {section !== 'response' && response && (
          <Text>
            {'  '}
            {response}
          </Text>
        )}
        {section === 'response' && (
          <TextInput
            key="response"
            prompt=""
            initialValue=""
            allowEmpty
            onSubmit={handleResponseSubmit}
            onCancel={goBackSection}
          />
        )}
      </Box>
    </Box>
  );
}
