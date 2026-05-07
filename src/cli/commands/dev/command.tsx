import { findConfigRoot, getWorkingDirectory } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { detectContainerRuntime } from '../../external-requirements';
import { ExecLogger } from '../../logging';
import {
  callMcpTool,
  createDevServer,
  findAvailablePort,
  getDevConfig,
  getDevSupportedAgents,
  getEndpointUrl,
  invokeAgent,
  invokeAgentStreaming,
  invokeForProtocol,
  listMcpTools,
  loadDevEnv,
  loadProjectConfig,
  resolveAgentPort,
} from '../../operations/dev';
import { OtelCollector, startOtelCollector } from '../../operations/dev/otel';
import { FatalError } from '../../tui/components';
import { LayoutProvider } from '../../tui/context';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject, requireTTY } from '../../tui/guards';
import { parseHeaderFlags } from '../shared/header-utils';
import { runBrowserMode } from './browser-mode';
import type { Command } from '@commander-js/extra-typings';
import { spawn } from 'child_process';
import { Text, render } from 'ink';
import path from 'node:path';
import React from 'react';

// Alternate screen buffer - same as main TUI
const ENTER_ALT_SCREEN = '\x1B[?1049h\x1B[H';
const EXIT_ALT_SCREEN = '\x1B[?1049l';
const SHOW_CURSOR = '\x1B[?25h';

async function invokeDevServer(
  port: number,
  prompt: string,
  stream: boolean,
  headers?: Record<string, string>
): Promise<void> {
  try {
    if (stream) {
      // Stream response to stdout
      for await (const chunk of invokeAgentStreaming({ port, message: prompt, headers })) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
    } else {
      const response = await invokeAgent({ port, message: prompt, headers });
      console.log(response);
    }
  } catch (err) {
    if (isConnectionRefused(err)) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev --logs');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function invokeA2ADevServer(port: number, prompt: string, headers?: Record<string, string>): Promise<void> {
  try {
    for await (const chunk of invokeForProtocol('A2A', { port, message: prompt, headers })) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  } catch (err) {
    if (isConnectionRefused(err)) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev --logs');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // ConnectionError from invoke.ts wraps fetch failures after retries
  if (err.name === 'ConnectionError') return true;
  const msg = err.message + (err.cause instanceof Error ? err.cause.message : '');
  return msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
}

async function handleMcpInvoke(
  port: number,
  invokeValue: string,
  toolName?: string,
  input?: string,
  headers?: Record<string, string>
): Promise<void> {
  try {
    if (invokeValue === 'list-tools') {
      const { tools } = await listMcpTools(port, undefined, headers);
      if (tools.length === 0) {
        console.log('No tools available.');
        return;
      }
      console.log('Available tools:');
      for (const tool of tools) {
        const desc = tool.description ? ` - ${tool.description}` : '';
        console.log(`  ${tool.name}${desc}`);
      }
    } else if (invokeValue === 'call-tool') {
      if (!toolName) {
        console.error('Error: --tool is required with call-tool');
        console.error('Usage: agentcore dev call-tool --tool <name> --input \'{"arg": "value"}\'');
        process.exit(1);
      }
      // Initialize session first, then call tool with the session ID
      const { sessionId } = await listMcpTools(port, undefined, headers);
      let args: Record<string, unknown> = {};
      if (input) {
        try {
          args = JSON.parse(input) as Record<string, unknown>;
        } catch {
          console.error(`Error: Invalid JSON for --input: ${input}`);
          console.error('Expected format: --input \'{"key": "value"}\'');
          process.exit(1);
        }
      }
      const result = await callMcpTool(port, toolName, args, sessionId, undefined, headers);
      console.log(result);
    } else {
      console.error(`Error: Unknown MCP invoke command "${invokeValue}"`);
      console.error('Usage:');
      console.error('  agentcore dev list-tools');
      console.error('  agentcore dev call-tool --tool <name> --input \'{"arg": "value"}\'');
      process.exit(1);
    }
  } catch (err) {
    if (isConnectionRefused(err)) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev --logs');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function execInContainer(command: string, containerName: string): Promise<void> {
  const detection = await detectContainerRuntime();
  if (!detection.runtime) {
    console.error('Error: No container runtime found (docker, podman, or finch required)');
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(detection.runtime!.binary, ['exec', containerName, 'bash', '-c', command], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && code !== null) {
        process.exit(code);
      }
      resolve();
    });
  });
}

export const registerDev = (program: Command) => {
  program
    .command('dev')
    .alias('d')
    .description(COMMAND_DESCRIPTIONS.dev)
    .argument('[prompt]', 'Send a prompt to a running dev server [non-interactive]')
    .option(
      '-p, --port <port>',
      'Base port for development server. With multiple runtimes, the actual port is base + runtime index when --port is omitted; when --port is passed explicitly the value is used literally and a port conflict fails fast.',
      '8080'
    )
    .option('-r, --runtime <name>', 'Runtime to run or invoke (required if multiple runtimes)')
    .option('-s, --stream', 'Stream response when invoking [non-interactive]')
    .option('-l, --logs', 'Run dev server with logs to stdout [non-interactive]')
    .option('--exec', 'Execute a shell command in the running dev container (Container agents only) [non-interactive]')
    .option('--tool <name>', 'MCP tool name (used with "call-tool" prompt) [non-interactive]')
    .option('--input <json>', 'MCP tool arguments as JSON (used with --tool) [non-interactive]')
    .option(
      '-H, --header <header>',
      'Custom header to forward to the agent (format: "Name: Value", repeatable) [non-interactive]',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option('-b, --no-browser', 'Use terminal TUI instead of web-based chat UI')
    .option('--no-traces', 'Disable local OTEL trace collection')

    .action(async (positionalPrompt: string | undefined, opts, command) => {
      try {
        const port = parseInt(opts.port, 10);
        // Was --port passed explicitly (CLI flag, env, or config), or are we
        // using the registered default? Any non-default source is treated as
        // explicit so the user's value is honored literally — issue #1079.
        //
        // Commander v14 always provides `command` and `getOptionValueSource`
        // on the action callback. The optional chain below is defensive: if
        // either is missing (older Commander, exotic test harness), the value
        // falls back to "implicit" rather than throwing. To prevent silent
        // regressions, we explicitly check that the API is present.
        if (!command || typeof command.getOptionValueSource !== 'function') {
          // eslint-disable-next-line no-console
          console.warn(
            'Warning: Commander command/getOptionValueSource unavailable; --port will be treated as implicit.'
          );
        }
        const portSource = command?.getOptionValueSource?.('port');
        const portIsExplicit = portSource !== undefined && portSource !== 'default';
        // Note: passing `-p 8080` (matching the registered default) is now
        // treated as explicit, which means it disables the runtime-index
        // offset and fails fast on conflict. This is the intended behavior of
        // issue #1079 and is documented in the --port help text and CHANGELOG.

        // Parse custom headers
        let headers: Record<string, string> | undefined;
        if (opts.header && opts.header.length > 0) {
          headers = parseHeaderFlags(opts.header);
        }

        // Exec mode: run shell command in the dev container
        if (opts.exec) {
          if (!positionalPrompt) {
            console.error('A command is required with --exec. Usage: agentcore dev --exec "whoami"');
            process.exit(1);
          }
          const workingDir = getWorkingDirectory();
          const project = await loadProjectConfig(workingDir);
          const agentName = opts.runtime ?? project?.runtimes[0]?.name ?? 'unknown';
          const targetAgent = project?.runtimes.find(a => a.name === agentName);
          if (targetAgent?.build !== 'Container') {
            console.error('Error: --exec is only supported for Container build agents.');
            console.error('For CodeZip agents, use your terminal to run commands directly.');
            process.exit(1);
          }
          const containerName = `agentcore-dev-${agentName}`.toLowerCase();
          await execInContainer(positionalPrompt, containerName);
          return;
        }

        // If a prompt is provided, invoke a running dev server
        const invokePrompt = positionalPrompt;
        if (invokePrompt !== undefined) {
          const workingDir = getWorkingDirectory();
          const invokeProject = await loadProjectConfig(workingDir);

          // Determine which agent/port to invoke
          let invokePort = port;
          let targetAgent = invokeProject?.runtimes[0];
          if (opts.runtime && invokeProject) {
            // Honor explicit --port literally; otherwise apply the historical
            // base + runtime index offset so we hit the auto-allocated port.
            invokePort = resolveAgentPort(invokeProject, opts.runtime, port, { explicit: portIsExplicit }).port;
            targetAgent = invokeProject.runtimes.find(a => a.name === opts.runtime);
          } else if (invokeProject && invokeProject.runtimes.length > 1 && !opts.runtime) {
            const names = invokeProject.runtimes.map(a => a.name).join(', ');
            console.error(`Error: Multiple runtimes found. Use --runtime to specify which one.`);
            console.error(`Available: ${names}`);
            process.exit(1);
          }

          const protocol = targetAgent?.protocol ?? 'HTTP';

          // Override port for protocols with fixed framework ports
          if (protocol === 'A2A') invokePort = 9000;
          else if (protocol === 'MCP') invokePort = 8000;

          // Protocol-aware dispatch
          if (protocol === 'MCP') {
            await handleMcpInvoke(invokePort, invokePrompt, opts.tool, opts.input, headers);
          } else if (protocol === 'A2A') {
            await invokeA2ADevServer(invokePort, invokePrompt, headers);
          } else if (protocol === 'AGUI') {
            for await (const chunk of invokeForProtocol('AGUI', { port: invokePort, message: invokePrompt, headers })) {
              process.stdout.write(chunk);
            }
            process.stdout.write('\n');
          } else {
            await invokeDevServer(invokePort, invokePrompt, opts.stream ?? false, headers);
          }
          return;
        }

        requireProject();

        const workingDir = getWorkingDirectory();
        const project = await loadProjectConfig(workingDir);

        if (!project) {
          render(<FatalError message="No agentcore project found." suggestedCommand="agentcore create" />);
          process.exit(1);
        }

        if (!project.runtimes || project.runtimes.length === 0) {
          render(<FatalError message="No agents defined in project." suggestedCommand="agentcore add agent" />);
          process.exit(1);
        }

        // Warn about VPC mode limitations in local dev
        const targetDevAgent = opts.runtime ? project.runtimes.find(a => a.name === opts.runtime) : project.runtimes[0];
        if (targetDevAgent?.networkMode === 'VPC') {
          console.log(
            '\x1b[33mWarning: This agent uses VPC network mode. Local dev server runs outside your VPC. Network behavior may differ from deployed environment.\x1b[0m\n'
          );
        }

        const supportedAgents = getDevSupportedAgents(project);
        if (supportedAgents.length === 0) {
          render(
            <FatalError message="No agents support dev mode. Dev mode requires Python agents with an entrypoint." />
          );
          process.exit(1);
        }

        // Start local OTEL collector so agent traces are captured in dev mode.
        // Persists traces to .cli/traces/ so they survive dev server restarts.
        const configRoot = findConfigRoot(workingDir);
        let otelEnvVars: Record<string, string> = {};
        let collector: OtelCollector | undefined;

        if (opts.traces !== false) {
          const persistTracesDir = path.join(configRoot ?? workingDir, '.cli', 'traces');
          const otelResult = await startOtelCollector(persistTracesDir);
          collector = otelResult.collector;
          otelEnvVars = otelResult.otelEnvVars;
        }

        // If --logs provided, run non-interactive mode
        if (opts.logs) {
          // Require --agent if multiple agents
          if (project.runtimes.length > 1 && !opts.runtime) {
            const names = project.runtimes.map(a => a.name).join(', ');
            console.error(`Error: Multiple runtimes found. Use --runtime to specify which one.`);
            console.error(`Available: ${names}`);
            process.exit(1);
          }

          const agentName = opts.runtime ?? project.runtimes[0]?.name;
          const { envVars } = await loadDevEnv(workingDir);
          const mergedEnvVars = { ...envVars, ...otelEnvVars };
          const config = getDevConfig(workingDir, project, configRoot ?? undefined, agentName);

          if (!config) {
            console.error('Error: No dev-supported agents found.');
            process.exit(1);
          }

          // Create logger for log file path
          const logger = new ExecLogger({ command: 'dev' });

          // Calculate port: A2A/MCP use fixed framework ports, HTTP uses configurable port.
          // For HTTP we resolve via resolveAgentPort which honors explicit --port literally
          // and otherwise applies the historical base + runtime-index offset.
          const isA2A = config.protocol === 'A2A';
          const isMcp = config.protocol === 'MCP';
          const httpResolution = resolveAgentPort(project, config.agentName, port, { explicit: portIsExplicit });
          const fixedPort = isA2A ? 9000 : isMcp ? 8000 : httpResolution.port;

          // Surface the index-based offset so it isn't silent (issue #1079).
          if (!isA2A && !isMcp && httpResolution.offset > 0) {
            console.log(
              `Runtime "${config.agentName}" is at index ${httpResolution.offset}; using port ${fixedPort} ` +
                `(pass --port ${fixedPort} explicitly to override).`
            );
          }

          const actualPort = await findAvailablePort(fixedPort);
          if ((isA2A || isMcp) && actualPort !== fixedPort) {
            console.error(`Error: Port ${fixedPort} is in use. ${config.protocol} agents require port ${fixedPort}.`);
            process.exit(1);
          }
          if (!isA2A && !isMcp && portIsExplicit && actualPort !== fixedPort) {
            console.error(
              `Error: Port ${fixedPort} is in use. Pass a different --port or stop the conflicting process.`
            );
            process.exit(1);
          }
          if (actualPort !== fixedPort) {
            console.log(`Port ${fixedPort} in use, using ${actualPort}`);
          }

          // Get provider info from agent config
          const providerInfo = '(see agent code)';

          console.log(`Starting dev server...`);
          console.log(`Agent: ${config.agentName}`);
          if (config.protocol !== 'MCP') {
            console.log(`Provider: ${providerInfo}`);
          }
          if (config.protocol !== 'HTTP') {
            console.log(`Protocol: ${config.protocol}`);
          }
          console.log(`Server: ${getEndpointUrl(actualPort, config.protocol)}`);
          console.log(`Log: ${logger.getRelativeLogPath()}`);
          console.log(`Press Ctrl+C to stop\n`);

          const devCallbacks = {
            onLog: (level: string, msg: string) => {
              const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '→';
              console.log(`${prefix} ${msg}`);
              logger.log(msg, level === 'error' ? 'error' : 'info');
            },
            onExit: (code: number | null) => {
              console.log(`\nServer exited with code ${code ?? 0}`);
              logger.finalize(code === 0);
              process.exit(code ?? 0);
            },
          };

          const server = createDevServer(config, { port: actualPort, envVars: mergedEnvVars, callbacks: devCallbacks });
          await server.start();

          // Handle Ctrl+C — use server.kill() for proper container cleanup
          process.on('SIGINT', () => {
            console.log('\nStopping server...');
            collector?.stop();
            server.kill();
          });

          // Keep process alive
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          await new Promise(() => {});
        }

        // If --no-browser provided, launch terminal TUI mode
        if (!opts.browser) {
          requireTTY();
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
                portIsExplicit={portIsExplicit}
                agentName={opts.runtime}
                headers={headers}
              />
            </LayoutProvider>
          );

          await waitUntilExit();
          exitAltScreen();
          return;
        }

        // Default: launch web UI in browser
        await runBrowserMode({
          workingDir,
          project,
          port,
          portIsExplicit,
          agentName: opts.runtime,
          otelEnvVars,
          collector,
        });
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
