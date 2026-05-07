/**
 * Config Bundle Flow — manages navigation between hub, version history, and diff screens.
 */
import { ConfigBundleHubScreen } from './ConfigBundleHubScreen';
import { DiffScreen } from './DiffScreen';
import { VersionHistoryScreen } from './VersionHistoryScreen';
import type { BundleWithMeta } from './useConfigBundleHub';
import React, { useState } from 'react';

type FlowState =
  | { name: 'hub' }
  | { name: 'versions'; bundle: BundleWithMeta; region: string }
  | { name: 'diff'; bundle: BundleWithMeta; region: string; fromVersionId: string; toVersionId: string };

interface ConfigBundleFlowProps {
  onExit: () => void;
}

export function ConfigBundleFlow({ onExit }: ConfigBundleFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'hub' });

  if (flow.name === 'hub') {
    return (
      <ConfigBundleHubScreen
        onSelectBundle={(bundle, region) => {
          setFlow({ name: 'versions', bundle, region });
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'versions') {
    return (
      <VersionHistoryScreen
        bundle={flow.bundle}
        region={flow.region}
        onViewDiff={(bundleId, fromVersionId, toVersionId) =>
          setFlow({ name: 'diff', bundle: flow.bundle, region: flow.region, fromVersionId, toVersionId })
        }
        onExit={() => setFlow({ name: 'hub' })}
      />
    );
  }

  if (flow.name === 'diff') {
    return (
      <DiffScreen
        bundleId={flow.bundle.bundleId}
        bundleName={flow.bundle.bundleName}
        fromVersionId={flow.fromVersionId}
        toVersionId={flow.toVersionId}
        region={flow.region}
        onExit={() => setFlow({ name: 'versions', bundle: flow.bundle, region: flow.region })}
      />
    );
  }

  return null;
}
