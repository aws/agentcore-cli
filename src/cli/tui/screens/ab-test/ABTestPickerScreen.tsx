import { ConfigIO } from '../../../../lib';
import type { SelectableItem } from '../../components';
import { Screen, SelectScreen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { ABTestDetailScreen } from './ABTestDetailScreen';
import { Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

interface ABTestPickerScreenProps {
  onExit: () => void;
}

interface DeployedABTest {
  name: string;
  abTestId: string;
}

export function ABTestPickerScreen({ onExit }: ABTestPickerScreenProps) {
  const [tests, setTests] = useState<DeployedABTest[] | null>(null);
  const [selectedTest, setSelectedTest] = useState<DeployedABTest | null>(null);
  const [region, setRegion] = useState('us-east-1');

  const hasFetched = useRef(false);
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    const load = async () => {
      try {
        const configIO = new ConfigIO();
        const [deployedState, targets] = await Promise.all([
          configIO.readDeployedState(),
          configIO.resolveAWSDeploymentTargets(),
        ]);
        const found: DeployedABTest[] = [];
        for (const target of Object.values(deployedState.targets ?? {})) {
          const abTests = target.resources?.abTests;
          if (abTests) {
            for (const [name, state] of Object.entries(abTests)) {
              found.push({ name, abTestId: state.abTestId });
            }
          }
        }
        setTests(found);
        if (targets.length > 0) setRegion(targets[0]!.region);
      } catch {
        setTests([]);
      }
    };
    void load();
  }, []);

  if (selectedTest) {
    return <ABTestDetailScreen abTestId={selectedTest.abTestId} region={region} onExit={() => setSelectedTest(null)} />;
  }

  if (tests === null) {
    return (
      <Screen title="AB Tests" onExit={onExit} helpText={HELP_TEXT.EXIT}>
        <Text dimColor>Loading AB tests...</Text>
      </Screen>
    );
  }

  if (tests.length === 0) {
    return (
      <Screen title="AB Tests" onExit={onExit} helpText={HELP_TEXT.EXIT}>
        <Text>No deployed AB tests found.</Text>
        <Text dimColor>Add one with `agentcore add ab-test` and deploy.</Text>
      </Screen>
    );
  }

  const items: SelectableItem[] = tests.map(t => ({
    id: t.name,
    title: t.name,
    description: `ID: ${t.abTestId}`,
  }));

  return (
    <SelectScreen
      title="Select AB Test"
      items={items}
      onSelect={item => {
        const test = tests.find(t => t.name === item.id);
        if (test) setSelectedTest(test);
      }}
      onExit={onExit}
    />
  );
}
