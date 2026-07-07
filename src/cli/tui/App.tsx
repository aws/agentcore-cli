import { getWorkingDirectory } from '../../lib';
import { createProgram } from '../cli';
import { LayoutProvider } from './context';
import { CLI_ONLY_EXAMPLES } from './copy';
import { setExitAction } from './exit-action';
import { MissingProjectMessage, WrongDirectoryMessage, getProjectRootMismatch, projectExists } from './guards';
import { AddFlow } from './screens/add/AddFlow';
import { CliOnlyScreen } from './screens/cli-only';
import { ConfigBundleFlow } from './screens/config-bundle-hub';
import { CreateScreen } from './screens/create';
import { DatasetFlow } from './screens/dataset-hub';
import { DeployScreen } from './screens/deploy/DeployScreen';
import { EvalHubScreen, EvalScreen } from './screens/eval';
import { ExportHarnessFlow } from './screens/export';
import { FetchAccessScreen } from './screens/fetch-access';
import { HelpScreen, HomeScreen } from './screens/home';
import { ImportFlow } from './screens/import';
import { InsightsJobsScreen } from './screens/insights-jobs';
import { InvokeScreen } from './screens/invoke';
import { LogsScreen } from './screens/logs';
import { OnlineEvalDashboard } from './screens/online-eval';
import { PackageScreen } from './screens/package';
import { RecommendationFlow, RecommendationHistoryScreen, RecommendationsHubScreen } from './screens/recommendation';
import { RemoveFlow } from './screens/remove';
import { ABTestJobsHistoryScreen, RunABTestFlow } from './screens/run-ab-test';
import { BatchEvalHistoryScreen, RunBatchEvalFlow, RunEvalFlow, RunIngestFlow, RunScreen } from './screens/run-eval';
import { RunInsightsFlow } from './screens/run-insights';
import { StatusScreen } from './screens/status/StatusScreen';
import { UpdateScreen } from './screens/update';
import { ValidateScreen } from './screens/validate';
import { ViewTypePickerScreen } from './screens/view';
import { getCommandsForUI } from './utils/commands';
import { useApp } from 'ink';
import React, { useState } from 'react';

// cwd is captured inside AppContent to avoid calling getWorkingDirectory at import time

type Route =
  | { name: 'home' }
  | { name: 'help'; initialQuery?: string }
  | { name: 'deploy'; diffMode?: boolean }
  | {
      name: 'invoke';
      sessionId?: string;
      userId?: string;
      headers?: Record<string, string>;
      bearerToken?: string;
      isResume?: boolean;
      paymentInstrumentId?: string;
      paymentSessionId?: string;
      paymentUserId?: string;
      autoSession?: boolean;
    }
  | { name: 'logs' }
  | { name: 'create' }
  | { name: 'add' }
  | { name: 'status' }
  | { name: 'remove'; screen?: 'all' }
  | { name: 'run' }
  | { name: 'run-eval'; from?: 'run' | 'evals' }
  | { name: 'run-batch-eval'; from?: 'run' | 'evals' }
  | { name: 'run-ingest'; from?: 'run' }
  | { name: 'batch-eval-history' }
  | { name: 'run-insights'; from?: 'run' | 'evals' }
  | { name: 'insights-jobs' }
  | { name: 'recommendations-hub' }
  | { name: 'recommend'; from?: 'recommendations-hub' | 'run' }
  | { name: 'recommendation-history' }
  | { name: 'run-ab-test'; from?: 'run' }
  | { name: 'ab-test-jobs' }
  | { name: 'view' }
  | { name: 'evals' }
  | { name: 'eval-runs' }
  | { name: 'online-evals' }
  | { name: 'fetch-access' }
  | { name: 'validate' }
  | { name: 'package' }
  | { name: 'update' }
  | { name: 'config-bundle' }
  | { name: 'dataset' }
  | { name: 'import' }
  | { name: 'export-harness' }
  | { name: 'cli-only'; commandId: string };

// Commands that don't require being at the project root
const PROJECT_ROOT_EXEMPT_COMMANDS = new Set(['create', 'update']);

export type RouteName = Route['name'];

// Excluded: cli-only is a TUI-internal screen that tells users to use the CLI — we should never launch the TUI just to show that.
export type InitialRoute = Exclude<Route, { name: 'cli-only' }>;

function AppContent({
  initialRoute,
  actionOnBack,
  isInteractive = true,
}: {
  initialRoute?: InitialRoute;
  actionOnBack?: 'help' | 'exit';
  isInteractive?: boolean;
}) {
  const { exit } = useApp();
  const cwd = getWorkingDirectory();
  // Start on help screen if project exists (show commands), otherwise home (show Quick Start)
  const inProject = projectExists();
  const wrongDirProjectRoot = getProjectRootMismatch();
  const defaultRoute: Route = inProject ? { name: 'help' } : { name: 'home' };
  const [route, setRoute] = useState<Route>(initialRoute ?? defaultRoute);
  const [helpNotice, setHelpNotice] = useState<React.ReactNode | null>(null);

  const handleBack = () => {
    if (actionOnBack === 'exit') {
      exit();
    } else {
      setRoute({ name: 'help' });
    }
  };

  // Get commands from commander program (hide 'create' when in project)
  const program = createProgram();
  const commands = getCommandsForUI(program, { inProject });

  const onSelectCommand = (id: string) => {
    const cmd = commands.find(c => c.id === id);
    if (!cmd) return;

    if (id !== 'add') {
      setHelpNotice(null);
    }

    // Block commands that require project root when in a subdirectory
    if (wrongDirProjectRoot && !PROJECT_ROOT_EXEMPT_COMMANDS.has(id)) {
      setHelpNotice(<WrongDirectoryMessage projectRoot={wrongDirProjectRoot} />);
      return;
    }

    // CLI-only commands → show usage info screen
    const cliOnlyExamples = CLI_ONLY_EXAMPLES[id];
    if (cliOnlyExamples) {
      setRoute({ name: 'cli-only', commandId: id });
      return;
    }

    if (id === 'dev') {
      setExitAction({ type: 'dev' });
      exit();
      return;
    } else if (id === 'exec') {
      setExitAction({ type: 'exec' });
      exit();
      return;
    } else if (id === 'deploy') {
      setRoute({ name: 'deploy' });
    } else if (id === 'invoke') {
      setRoute({ name: 'invoke' });
    } else if (id === 'logs') {
      setRoute({ name: 'logs' });
    } else if (id === 'status') {
      setRoute({ name: 'status' });
    } else if (id === 'create') {
      setRoute({ name: 'create' });
    } else if (id === 'add') {
      if (!projectExists() && route.name === 'help') {
        setHelpNotice(<MissingProjectMessage inTui />);
        return;
      }
      setRoute({ name: 'add' });
    } else if (id === 'remove') {
      setRoute({ name: 'remove' });
    } else if (id === 'run') {
      setRoute({ name: 'run' });
    } else if (id === 'evals') {
      setRoute({ name: 'evals' });
    } else if (id === 'fetch') {
      setRoute({ name: 'fetch-access' });
    } else if (id === 'view') {
      setRoute({ name: 'view' });
    } else if (id === 'validate') {
      setRoute({ name: 'validate' });
    } else if (id === 'package') {
      setRoute({ name: 'package' });
    } else if (id === 'import') {
      if (!projectExists() && route.name === 'help') {
        setHelpNotice(<MissingProjectMessage inTui />);
        return;
      }
      setRoute({ name: 'import' });
    } else if (id === 'update') {
      setRoute({ name: 'update' });
    } else if (id === 'batch-evaluations') {
      setRoute({ name: 'batch-eval-history' });
    } else if (id === 'config-bundle') {
      setRoute({ name: 'config-bundle' });
    } else if (id === 'dataset') {
      setRoute({ name: 'dataset' });
    } else if (id === 'export') {
      if (!projectExists() && route.name === 'help') {
        setHelpNotice(<MissingProjectMessage inTui />);
        return;
      }
      setRoute({ name: 'export-harness' });
    }
  };

  if (route.name === 'home') {
    return (
      <HomeScreen
        cwd={cwd}
        version={program.version() ?? '0.0.0'}
        onShowHelp={initialQuery => setRoute({ name: 'help', initialQuery })}
        onSelectCreate={() => setRoute({ name: 'create' })}
      />
    );
  }

  if (route.name === 'help') {
    return (
      <HelpScreen
        commands={commands}
        initialQuery={route.initialQuery}
        notice={helpNotice ?? undefined}
        onNoticeDismiss={() => setHelpNotice(null)}
        onSelect={onSelectCommand}
        onBack={() => {
          setHelpNotice(null);
          exit();
        }}
      />
    );
  }

  if (route.name === 'deploy') {
    return (
      <DeployScreen
        isInteractive={isInteractive}
        diffMode={route.diffMode}
        onExit={handleBack}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'invoke') {
    return (
      <InvokeScreen
        isInteractive={isInteractive}
        onExit={handleBack}
        initialSessionId={route.sessionId}
        isResume={route.isResume}
        initialUserId={route.userId}
        initialHeaders={route.headers}
        initialBearerToken={route.bearerToken}
        onExec={result => {
          setExitAction({
            type: 'exec-shell',
            runtimeArn: result.runtimeArn,
            region: result.region,
            sessionId: result.sessionId,
          });
          exit();
        }}
        initialPaymentInstrumentId={route.paymentInstrumentId}
        initialPaymentSessionId={route.paymentSessionId}
        initialPaymentUserId={route.paymentUserId}
        initialAutoSession={route.autoSession}
      />
    );
  }

  if (route.name === 'logs') {
    return <LogsScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'status') {
    return <StatusScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'add') {
    return (
      <AddFlow
        isInteractive={isInteractive}
        onExit={handleBack}
        onDev={() => {
          setExitAction({ type: 'dev' });
          exit();
        }}
        onDeploy={() => setRoute({ name: 'deploy' })}
      />
    );
  }

  if (route.name === 'remove') {
    return (
      <RemoveFlow
        isInteractive={isInteractive}
        onExit={handleBack}
        onNavigate={command => setRoute({ name: command } as Route)}
        initialResourceType={route.screen}
      />
    );
  }

  if (route.name === 'create') {
    return (
      <CreateScreen
        cwd={cwd}
        isInteractive={isInteractive}
        onExit={handleBack}
        onNavigate={({ command, workingDir }) => {
          process.chdir(workingDir);
          setRoute({ name: command } as Route);
        }}
      />
    );
  }

  if (route.name === 'run') {
    return (
      <RunScreen
        onRunEval={() => setRoute({ name: 'run-eval', from: 'run' })}
        onRunBatchEval={() => setRoute({ name: 'run-batch-eval', from: 'run' })}
        onRunInsights={() => setRoute({ name: 'run-insights', from: 'run' })}
        onRunRecommendation={() => setRoute({ name: 'recommend', from: 'run' })}
        onRunIngest={() => setRoute({ name: 'run-ingest', from: 'run' })}
        onRunABTest={() => setRoute({ name: 'run-ab-test', from: 'run' })}
        onExit={handleBack}
      />
    );
  }

  if (route.name === 'run-insights') {
    return (
      <RunInsightsFlow
        onExit={handleBack}
        onBack={() => setRoute({ name: route.from ?? 'run' } as Route)}
        onViewJobs={() => setRoute({ name: 'insights-jobs' })}
      />
    );
  }

  if (route.name === 'evals') {
    return (
      <EvalHubScreen
        onSelect={view => {
          if (view === 'run-eval') setRoute({ name: 'run-eval', from: 'evals' });
          if (view === 'runs') setRoute({ name: 'eval-runs' });
          if (view === 'run-batch-eval') setRoute({ name: 'run-batch-eval', from: 'evals' });
          if (view === 'batch-eval-history') setRoute({ name: 'batch-eval-history' });
          if (view === 'run-insights') setRoute({ name: 'run-insights', from: 'evals' });
          if (view === 'insights-jobs') setRoute({ name: 'insights-jobs' });
          if (view === 'online-dashboard') setRoute({ name: 'online-evals' });
        }}
        onExit={handleBack}
      />
    );
  }

  if (route.name === 'run-eval') {
    const backRoute = route.from ?? 'evals';
    return (
      <RunEvalFlow
        onExit={() => setRoute({ name: backRoute } as Route)}
        onViewRuns={() => setRoute({ name: 'eval-runs' })}
      />
    );
  }

  if (route.name === 'run-batch-eval') {
    const backRoute = route.from ?? 'run';
    return (
      <RunBatchEvalFlow
        onExit={() => setRoute({ name: backRoute } as Route)}
        onViewJobs={() => setRoute({ name: 'batch-eval-history' })}
      />
    );
  }

  if (route.name === 'run-ingest') {
    const backRoute = route.from ?? 'run';
    return <RunIngestFlow onExit={() => setRoute({ name: backRoute } as Route)} />;
  }

  if (route.name === 'view') {
    return (
      <ViewTypePickerScreen
        onSelect={view => {
          if (view === 'recommendation') setRoute({ name: 'recommendation-history' });
          if (view === 'batch-evaluation') setRoute({ name: 'batch-eval-history' });
          if (view === 'ab-test') setRoute({ name: 'ab-test-jobs' });
        }}
        onExit={handleBack}
      />
    );
  }

  if (route.name === 'batch-eval-history') {
    return <BatchEvalHistoryScreen onExit={() => setRoute({ name: 'view' })} />;
  }

  if (route.name === 'insights-jobs') {
    return <InsightsJobsScreen onExit={() => setRoute({ name: 'evals' })} />;
  }

  if (route.name === 'recommendations-hub') {
    return (
      <RecommendationsHubScreen
        onSelect={view => {
          if (view === 'run-recommendation') setRoute({ name: 'recommend', from: 'recommendations-hub' });
          if (view === 'recommendation-history') setRoute({ name: 'recommendation-history' });
        }}
        onExit={handleBack}
      />
    );
  }

  if (route.name === 'recommend') {
    const backRoute = route.from ?? 'run';
    return (
      <RecommendationFlow
        onExit={() => setRoute({ name: backRoute } as Route)}
        onViewJobs={() => setRoute({ name: 'recommendation-history' })}
      />
    );
  }

  if (route.name === 'recommendation-history') {
    return <RecommendationHistoryScreen onExit={() => setRoute({ name: 'view' })} />;
  }

  if (route.name === 'run-ab-test') {
    const backRoute = route.from ?? 'run';
    return (
      <RunABTestFlow
        onExit={() => setRoute({ name: backRoute } as Route)}
        onViewJobs={() => setRoute({ name: 'ab-test-jobs' })}
      />
    );
  }

  if (route.name === 'ab-test-jobs') {
    return <ABTestJobsHistoryScreen onExit={() => setRoute({ name: 'view' })} />;
  }

  if (route.name === 'eval-runs') {
    return <EvalScreen isInteractive={isInteractive} onExit={() => setRoute({ name: 'evals' })} />;
  }

  if (route.name === 'online-evals') {
    return <OnlineEvalDashboard isInteractive={isInteractive} onExit={() => setRoute({ name: 'evals' })} />;
  }

  if (route.name === 'fetch-access') {
    return <FetchAccessScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'validate') {
    return <ValidateScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'package') {
    return <PackageScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'import') {
    return (
      <ImportFlow
        onBack={() => setRoute({ name: 'help' })}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'update') {
    return <UpdateScreen isInteractive={isInteractive} onExit={handleBack} />;
  }

  if (route.name === 'config-bundle') {
    return <ConfigBundleFlow onExit={handleBack} />;
  }

  if (route.name === 'dataset') {
    return <DatasetFlow onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'export-harness') {
    return (
      <ExportHarnessFlow
        isInteractive={isInteractive}
        onExit={handleBack}
        onBack={handleBack}
        onDeploy={() => setRoute({ name: 'deploy' })}
      />
    );
  }

  if (route.name === 'cli-only') {
    const info = CLI_ONLY_EXAMPLES[route.commandId];
    if (info) {
      return (
        <CliOnlyScreen
          title={route.commandId}
          description={info.description}
          examples={info.examples}
          onExit={handleBack}
        />
      );
    }
  }

  return null;
}

export function App({
  initialRoute,
  actionOnBack,
  isInteractive = true,
}: {
  initialRoute?: InitialRoute;
  actionOnBack?: 'help' | 'exit';
  isInteractive?: boolean;
}) {
  return (
    <LayoutProvider>
      <AppContent initialRoute={initialRoute} actionOnBack={actionOnBack} isInteractive={isInteractive} />
    </LayoutProvider>
  );
}
