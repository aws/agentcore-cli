import { getWorkingDirectory } from '../../../lib';
import { invokeAgent, invokeAgentStreaming, loadProjectConfig } from '../../operations/dev';
import { FatalError } from '../../tui/components';
import { LayoutProvider } from '../../tui/context';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

// Alternate screen buffer - same as main TUI
const ENTER_ALT_SCREEN = '\x1B[?1049h\x1B[H';
const EXIT_ALT_SCREEN = '\x1B[?1049l';
const SHOW_CURSOR = '\x1B[?25h';

async function invokeDevServer(port: number, prompt: string, stream: boolean): Promise<void> {
  try {
    if (stream) {
      // Stream response to stdout
      for await (const chunk of invokeAgentStreaming(port, prompt)) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
    } else {
      const response = await invokeAgent(port, prompt);
      console.log(response);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

export const registerDev = (program: Command) => {
  program
    .command('dev')
    .alias('d')
    .description(COMMAND_DESCRIPTIONS.dev)
    .option('-p, --port <port>', 'Port for development server', '8080')
    .option('-a, --agent <name>', 'Agent to run or invoke (required if multiple agents)')
    .option('-i, --invoke <prompt>', 'Invoke the running dev server with a prompt')
    .option('-s, --stream', 'Stream response when using --invoke')
    .option('-l, --logs', 'Run dev server with logs to stdout (non-interactive)')
    .action(async opts => {
      const port = parseInt(opts.port, 10);

      // If --invoke provided, call the dev server and exit
      if (opts.invoke) {
        const { getAgentPort } = await import('../../operations/dev');
        const invokeProject = await loadProjectConfig(getWorkingDirectory());

        // Determine which agent/port to invoke
        let invokePort = port;
        if (opts.agent && invokeProject) {
          invokePort = getAgentPort(invokeProject, opts.agent, port);
        } else if (invokeProject && invokeProject.agents.length > 1 && !opts.agent) {
          const names = invokeProject.agents.map(a => a.name).join(', ');
          console.error(`Error: Multiple agents found. Use --agent to specify which one.`);
          console.error(`Available: ${names}`);
          process.exit(1);
        }

        await invokeDevServer(invokePort, opts.invoke, opts.stream ?? false);
        return;
      }

      const workingDir = getWorkingDirectory();
      const project = await loadProjectConfig(workingDir);

      if (!project) {
        render(<FatalError message="No agentcore project found." suggestedCommand="agentcore create" />);
        process.exit(1);
      }

      if (!project.agents || project.agents.length === 0) {
        render(<FatalError message="No agents defined in project." suggestedCommand="agentcore create" />);
        process.exit(1);
      }

      // If --logs provided, run non-interactive mode
      if (opts.logs) {
        const { findAvailablePort, getDevConfig, getAgentPort, spawnDevServer } = await import('../../operations/dev');
        const { findConfigRoot, readEnvFile } = await import('../../../lib');
        const { ExecLogger } = await import('../../logging');

        // Require --agent if multiple agents
        if (project.agents.length > 1 && !opts.agent) {
          const names = project.agents.map(a => a.name).join(', ');
          console.error(`Error: Multiple agents found. Use --agent to specify which one.`);
          console.error(`Available: ${names}`);
          process.exit(1);
        }

        const agentName = opts.agent ?? project.agents[0]?.name;
        const configRoot = findConfigRoot(workingDir);
        const envVars = configRoot ? await readEnvFile(configRoot) : {};
        const config = getDevConfig(workingDir, project, configRoot ?? undefined, agentName);

        // Create logger for log file path
        const logger = new ExecLogger({ command: 'dev' });

        // Calculate port based on agent index
        const basePort = getAgentPort(project, config.agentName, port);
        const actualPort = await findAvailablePort(basePort);
        if (actualPort !== basePort) {
          console.log(`Port ${basePort} in use, using ${actualPort}`);
        }

        console.log(`Starting dev server...`);
        console.log(`Agent: ${config.agentName}`);
        console.log(`Server: http://localhost:${actualPort}/invocations`);
        console.log(`Log: ${logger.getRelativeLogPath()}`);
        console.log(`Press Ctrl+C to stop\n`);

        const child = spawnDevServer({
          module: config.module,
          cwd: config.directory,
          port: actualPort,
          isPython: config.isPython,
          envVars,
          callbacks: {
            onLog: (level, msg) => {
              const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '→';
              console.log(`${prefix} ${msg}`);
              logger.log(msg, level === 'error' ? 'error' : 'info');
            },
            onExit: code => {
              console.log(`\nServer exited with code ${code ?? 0}`);
              logger.finalize(code === 0);
              process.exit(code ?? 0);
            },
          },
        });

        // Handle Ctrl+C
        process.on('SIGINT', () => {
          console.log('\nStopping server...');
          child.kill('SIGTERM');
        });

        // Keep process alive
        await new Promise(() => {});
      }

      // Enter alternate screen buffer for fullscreen mode
      process.stdout.write(ENTER_ALT_SCREEN);

      const exitAltScreen = () => {
        process.stdout.write(EXIT_ALT_SCREEN);
        process.stdout.write(SHOW_CURSOR);
      };

      const { DevScreen } = await import('../../tui/screens/dev/DevScreen');
      const { unmount, waitUntilExit } = render(
        <LayoutProvider>
          <DevScreen
            onBack={() => {
              exitAltScreen();
              unmount();
              process.exit(0);
            }}
            workingDir={workingDir}
            port={port}
            agentName={opts.agent}
          />
        </LayoutProvider>
      );

      await waitUntilExit();
      exitAltScreen();
    });
};
