import type { SelectableItem } from '../../components';
import { TextInput, WizardSelect } from '../../components';
import { useListNavigation } from '../../hooks';
import { Box, Text } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

type VariantSubField = 'controlBundle' | 'controlVersion' | 'treatmentBundle' | 'treatmentVersion' | 'treatmentWeight';

const SUB_FIELDS: VariantSubField[] = [
  'controlBundle',
  'controlVersion',
  'treatmentBundle',
  'treatmentVersion',
  'treatmentWeight',
];

export interface VariantConfig {
  controlBundle: string;
  controlVersion: string;
  treatmentBundle: string;
  treatmentVersion: string;
  treatmentWeight: number;
}

export type VersionLoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface VariantConfigFormProps {
  bundleItems: SelectableItem[];
  fetchVersionItems: (bundleName: string) => void;
  controlVersionItems: SelectableItem[];
  treatmentVersionItems: SelectableItem[];
  controlVersionLoadState: VersionLoadState;
  treatmentVersionLoadState: VersionLoadState;
  onComplete: (config: VariantConfig) => void;
  onCancel: () => void;
  onCreateBundle?: () => void;
}

export function VariantConfigForm({
  bundleItems,
  fetchVersionItems,
  controlVersionItems,
  treatmentVersionItems,
  controlVersionLoadState,
  treatmentVersionLoadState,
  onComplete,
  onCancel,
  onCreateBundle,
}: VariantConfigFormProps) {
  const [activeField, setActiveField] = useState<VariantSubField>('controlBundle');
  const [controlBundle, setControlBundle] = useState('');
  const [controlVersion, setControlVersion] = useState('');
  const [treatmentBundle, setTreatmentBundle] = useState('');
  const [treatmentVersion, setTreatmentVersion] = useState('');
  const [treatmentWeight, setTreatmentWeight] = useState('20');

  const augmentedBundleItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = [];
    if (onCreateBundle) {
      items.push({ id: '__create_bundle__', title: 'Create new config bundle', description: 'Add a new bundle first' });
    }
    items.push(...bundleItems);
    return items;
  }, [bundleItems, onCreateBundle]);

  const advanceField = useCallback(() => {
    const idx = SUB_FIELDS.indexOf(activeField);
    const next = SUB_FIELDS[idx + 1];
    if (next) setActiveField(next);
  }, [activeField]);

  // Navigation for each select sub-field
  const controlBundleNav = useListNavigation({
    items: augmentedBundleItems,
    onSelect: item => {
      if (item.id === '__create_bundle__') {
        onCreateBundle?.();
        return;
      }
      setControlBundle(item.id);
      fetchVersionItems(item.id);
      advanceField();
    },
    onExit: onCancel,
    isActive: activeField === 'controlBundle',
  });

  const controlVersionNav = useListNavigation({
    items: controlVersionItems,
    onSelect: item => {
      setControlVersion(item.id);
      advanceField();
    },
    onExit: () => setActiveField('controlBundle'),
    isActive: activeField === 'controlVersion' && controlVersionLoadState === 'loaded',
  });

  const treatmentBundleNav = useListNavigation({
    items: augmentedBundleItems,
    onSelect: item => {
      if (item.id === '__create_bundle__') {
        onCreateBundle?.();
        return;
      }
      setTreatmentBundle(item.id);
      fetchVersionItems(item.id);
      advanceField();
    },
    onExit: () => setActiveField('controlVersion'),
    isActive: activeField === 'treatmentBundle',
  });

  const treatmentVersionNav = useListNavigation({
    items: treatmentVersionItems,
    onSelect: item => {
      setTreatmentVersion(item.id);
      advanceField();
    },
    onExit: () => setActiveField('treatmentBundle'),
    isActive: activeField === 'treatmentVersion' && treatmentVersionLoadState === 'loaded',
  });

  const controlWeight = 100 - parseInt(treatmentWeight || '0', 10);

  const completedValue = (value: string, label: string) => (
    <Box>
      <Text dimColor>{label}: </Text>
      <Text color="green">{value || '(pending)'}</Text>
      {value && <Text color="green"> ✓</Text>}
    </Box>
  );

  const pendingValue = (label: string) => (
    <Box>
      <Text dimColor>{label}: </Text>
      <Text dimColor>(pending)</Text>
    </Box>
  );

  const renderVersionField = (
    isActive: boolean,
    loadState: VersionLoadState,
    items: SelectableItem[],
    nav: { selectedIndex: number },
    title: string,
    completedVersion: string,
    label: string
  ) => {
    if (!isActive) {
      return completedVersion ? completedValue(completedVersion.slice(0, 8), label) : pendingValue(label);
    }

    switch (loadState) {
      case 'loading':
        return <Text dimColor>{label}: Loading versions...</Text>;
      case 'error':
        return <Text color="red">{label}: Failed to load versions. Press Esc to go back and retry.</Text>;
      case 'loaded':
        if (items.length === 0) {
          return <Text color="red">{label}: No versions found. Deploy the config bundle first.</Text>;
        }
        return <WizardSelect title={title} items={items} selectedIndex={nav.selectedIndex} />;
      default:
        return <Text dimColor>{label}: Waiting...</Text>;
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold>Configure Variants</Text>

      {/* Control section */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Control (C):
        </Text>

        {activeField === 'controlBundle' ? (
          augmentedBundleItems.length > 0 ? (
            <WizardSelect
              title="  Select control bundle"
              items={augmentedBundleItems}
              selectedIndex={controlBundleNav.selectedIndex}
            />
          ) : (
            <Text color="red"> No deployed config bundles found.</Text>
          )
        ) : (
          completedValue(controlBundle, '  Bundle')
        )}

        {renderVersionField(
          activeField === 'controlVersion',
          controlVersionLoadState,
          controlVersionItems,
          controlVersionNav,
          '  Select control version',
          controlVersion,
          '  Version'
        )}
      </Box>

      {/* Treatment section */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          Treatment (T1):
        </Text>

        {activeField === 'treatmentBundle' ? (
          <WizardSelect
            title="  Select treatment bundle"
            items={augmentedBundleItems}
            selectedIndex={treatmentBundleNav.selectedIndex}
          />
        ) : treatmentBundle ? (
          completedValue(treatmentBundle, '  Bundle')
        ) : (
          pendingValue('  Bundle')
        )}

        {renderVersionField(
          activeField === 'treatmentVersion',
          treatmentVersionLoadState,
          treatmentVersionItems,
          treatmentVersionNav,
          '  Select treatment version',
          treatmentVersion,
          '  Version'
        )}

        {activeField === 'treatmentWeight' ? (
          <Box flexDirection="column">
            <TextInput
              key="weight"
              prompt={`  Treatment weight (1-99) — control will be ${controlWeight}%`}
              initialValue="20"
              onChange={value => setTreatmentWeight(value)}
              onSubmit={value => {
                const n = parseInt(value, 10);
                if (!isNaN(n) && n >= 1 && n <= 99) {
                  setTreatmentWeight(value);
                  onComplete({
                    controlBundle,
                    controlVersion,
                    treatmentBundle,
                    treatmentVersion,
                    treatmentWeight: n,
                  });
                }
              }}
              onCancel={() => setActiveField('treatmentVersion')}
              customValidation={(value: string) => {
                const n = parseInt(value, 10);
                if (isNaN(n)) return 'Must be a number';
                if (n < 1 || n > 99) return 'Must be between 1 and 99';
                return true;
              }}
            />
          </Box>
        ) : treatmentWeight && treatmentVersion ? (
          completedValue(`${treatmentWeight}% (control: ${controlWeight}%)`, '  Weight')
        ) : (
          pendingValue('  Weight')
        )}
      </Box>
    </Box>
  );
}
