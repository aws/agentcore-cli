import { ConfigIO } from '../../../lib';
import { validateAwsCredentials } from '../../aws/account';
import { getErrorMessage } from '../../errors';
import { createJobEngine } from '../../operations/jobs';
import type { JobRecord, JobType } from '../../operations/jobs';
import { ErrorPrompt, Screen } from '../../tui/components';
import { ABTestDetailView, BatchEvalDetailView, RecommendationDetailView } from '../../tui/screens/job-detail';
import { Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface JobDetailScreenProps {
  type: JobType;
  id: string;
  onExit: () => void;
}

type State = { name: 'loading' } | { name: 'error'; message: string } | { name: 'loaded'; record: JobRecord };

export function JobDetailScreen({ type, id, onExit }: JobDetailScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const [state, setState] = useState<State>({ name: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setState({ name: 'error', message: `AWS credentials required: ${getErrorMessage(err)}` });
        return;
      }
      try {
        const record = await engine.get(type, id);
        if (!record) {
          if (!cancelled) setState({ name: 'error', message: `Job "${id}" not found.` });
          return;
        }
        if (!cancelled) setState({ name: 'loaded', record });
      } catch (err) {
        if (!cancelled) setState({ name: 'error', message: getErrorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, type, id]);

  const handleUpdate = useCallback((updated: JobRecord) => {
    setState({ name: 'loaded', record: updated });
  }, []);

  if (state.name === 'loading') {
    return (
      <Screen title="Job Detail" onExit={onExit}>
        <Text dimColor>Loading job {id}...</Text>
      </Screen>
    );
  }

  if (state.name === 'error') {
    return <ErrorPrompt message="Job not found" detail={state.message} onBack={onExit} onExit={onExit} />;
  }

  const { record } = state;

  if (record.type === 'ab-test') {
    return (
      <Screen title="A/B Test Detail" onExit={onExit} exitEnabled={false}>
        <ABTestDetailView
          record={record}
          engine={engine}
          onBack={onExit}
          onUpdate={handleUpdate}
          backKey="q"
          backLabel="exit"
        />
      </Screen>
    );
  }
  if (record.type === 'batch-evaluation') {
    return (
      <Screen title="Batch Evaluation Detail" onExit={onExit} exitEnabled={false}>
        <BatchEvalDetailView
          record={record}
          engine={engine}
          onBack={onExit}
          onUpdate={handleUpdate}
          backKey="q"
          backLabel="exit"
        />
      </Screen>
    );
  }
  if (record.type === 'recommendation') {
    return (
      <Screen title="Recommendation Detail" onExit={onExit} exitEnabled={false}>
        <RecommendationDetailView record={record} onBack={onExit} backKey="q" backLabel="exit" />
      </Screen>
    );
  }
  return (
    <ErrorPrompt
      message="Unsupported job type"
      detail={`No detail view for job type "${record.type}".`}
      onBack={onExit}
      onExit={onExit}
    />
  );
}
