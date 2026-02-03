import { getWorkingDirectory } from '../../lib';
import { createProgram } from '../cli';
import { LayoutProvider } from './context';
import { MissingProjectMessage, projectExists } from './guards';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { AddFlow } from './screens/add/AddFlow';
import { AttachFlow } from './screens/attach/AttachFlow';
import { CreateScreen } from './screens/create';
import { DeployScreen } from './screens/deploy/DeployScreen';
import { DestroyScreen } from './screens/destroy';
import { DevScreen } from './screens/dev/DevScreen';
import { EditFlow } from './screens/edit';
import { HelpScreen, HomeScreen } from './screens/home';
import { InvokeScreen } from './screens/invoke';
import { OutlineScreen } from './screens/outline';
import { PackageScreen } from './screens/package';
import { PlanScreen } from './screens/plan/PlanScreen';
import { RemoveFlow } from './screens/remove';
import { StatusScreen } from './screens/status/StatusScreen';
import { UpdateScreen } from './screens/update';
import { ValidateScreen } from './screens/validate';
import { type CommandMeta, getCommandsForUI } from './utils/commands';
import { useApp } from 'ink';
import React, { useState } from 'react';

// Capture cwd once at app initialization
const cwd = getWorkingDirectory();

type Route =
  | { name: 'home' }
  | { name: 'help'; initialQuery?: string }
  | { name: 'command'; command: CommandMeta }
  | { name: 'dev' }
  | { name: 'deploy' }
  | { name: 'destroy' }
  | { name: 'invoke' }
  | { name: 'outline' }
  | { name: 'plan' }
  | { name: 'edit' }
  | { name: 'create' }
  | { name: 'add' }
  | { name: 'attach' }
  | { name: 'status' }
  | { name: 'remove' }
  | { name: 'validate' }
  | { name: 'package' }
  | { name: 'update' };

function AppContent() {
  const { exit } = useApp();
  // Start on help screen if project exists (show commands), otherwise home (show Quick Start)
  const inProject = projectExists();
  const initialRoute: Route = inProject ? { name: 'help' } : { name: 'home' };
  const [route, setRoute] = useState<Route>(initialRoute);
  const [helpNotice, setHelpNotice] = useState<React.ReactNode | null>(null);

  // Get commands from commander program (hide 'create' when in project)
  const program = createProgram();
  const commands = getCommandsForUI(program, { inProject });

  const onSelectCommand = (id: string) => {
    const cmd = commands.find(c => c.id === id);
    if (!cmd) return;

    if (id !== 'add') {
      setHelpNotice(null);
    }

    if (id === 'dev') {
      setRoute({ name: 'dev' });
    } else if (id === 'deploy') {
      setRoute({ name: 'deploy' });
    } else if (id === 'invoke') {
      setRoute({ name: 'invoke' });
    } else if (id === 'outline') {
      setRoute({ name: 'outline' });
    } else if (id === 'plan') {
      setRoute({ name: 'plan' });
    } else if (id === 'status') {
      setRoute({ name: 'status' });
    } else if (id === 'edit') {
      setRoute({ name: 'edit' });
    } else if (id === 'create') {
      setRoute({ name: 'create' });
    } else if (id === 'add') {
      if (!projectExists() && route.name === 'help') {
        setHelpNotice(<MissingProjectMessage inTui />);
        return;
      }
      setRoute({ name: 'add' });
    } else if (id === 'attach') {
      setRoute({ name: 'attach' });
    } else if (id === 'remove') {
      setRoute({ name: 'remove' });
    } else if (id === 'destroy') {
      setRoute({ name: 'destroy' });
    } else if (id === 'validate') {
      setRoute({ name: 'validate' });
    } else if (id === 'package') {
      setRoute({ name: 'package' });
    } else if (id === 'update') {
      setRoute({ name: 'update' });
    } else {
      setRoute({ name: 'command', command: cmd });
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

  if (route.name === 'dev') {
    return <DevScreen onBack={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'deploy') {
    return (
      <DeployScreen
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'invoke') {
    return <InvokeScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'outline') {
    return <OutlineScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'status') {
    return <StatusScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'plan') {
    return <PlanScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'edit') {
    return (
      <EditFlow
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onRequestAdd={() => setRoute({ name: 'add' })}
      />
    );
  }

  if (route.name === 'add') {
    return (
      <AddFlow
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'attach') {
    return <AttachFlow onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'remove') {
    return (
      <RemoveFlow
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onRequestDestroy={() => setRoute({ name: 'destroy' })}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'destroy') {
    return <DestroyScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'create') {
    return (
      <CreateScreen
        cwd={cwd}
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onNavigate={({ command, workingDir }) => {
          process.chdir(workingDir);
          setRoute({ name: command } as Route);
        }}
      />
    );
  }

  if (route.name === 'validate') {
    return (
      <ValidateScreen
        isInteractive={true}
        onExit={() => setRoute({ name: 'help' })}
        onNavigate={command => setRoute({ name: command } as Route)}
      />
    );
  }

  if (route.name === 'package') {
    return <PackageScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  if (route.name === 'update') {
    return <UpdateScreen isInteractive={true} onExit={() => setRoute({ name: 'help' })} />;
  }

  return <PlaceholderScreen command={route.command} onBack={() => setRoute({ name: 'help' })} />;
}

export function App() {
  return (
    <LayoutProvider>
      <AppContent />
    </LayoutProvider>
  );
}
