import {
  ConnectionError,
  ResourceNotFoundError,
  type Result,
  ValidationError,
  findConfigRoot,
  getWorkingDirectory,
} from '../../../lib';
import { getErrorMessage } from '../../errors';
import { detectContainerRuntime } from '../../external-requirements';
import { ExecLogger } from '../../logging';
import {
  callMcpTool,
  createDevServer,
  findAvailablePort,
  getAgentPort,
  getDevConfig,
  getDevSupportedAgents,
  getEndpointUrl,
  invokeAgent,
  invokeAgentStreaming,
  invokeForProtocol,
  listMcpTools,
  loadDevEnv,
  loadProjectConfig,
} from '../../operations/dev';
import { OtelCollector, startOtelCollector } from '../../operations/dev/otel';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { TelemetryClientAccessor } from '../../telemetry/client-accessor.js';
import { Protocol, standardize } from '../../telemetry/schemas/common-shapes.js';
import { FatalError } from '../../tui/components';
import { LayoutProvider } from '../../tui/context';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject, requireTTY } from '../../tui/guards';
import { parseHeaderFlags } from '../shared/header-utils';
import { runBrowserMode } from './browser-mode';
import type { Command } from '@commander-js/extra-typings';
import { spawn } from 'child_process';
import { render } from 'ink';
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
      for await (const chunk of invokeAgentStreaming({ port, message: prompt, headers })) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
    } else {
      const response = await invokeAgent({ port, message: prompt, headers });
      console.log(response);
    }
  } catch (err) {
    throw isConnectionRefused(err)
      ? new ConnectionError(`Dev server not running on port ${port}. Start it with: agentcore dev --logs`, {
          cause: err,
        })
      : err;
  }
}

async function invokeA2ADevServer(port: number, prompt: string, headers?: Record<string, string>): Promise<void> {
  try {
    for await (const chunk of invokeForProtocol('A2A', { port, message: prompt, headers })) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  } catch (err) {
    throw isConnectionRefused(err)
      ? new ConnectionError(`Dev server not running on port ${port}. Start it with: agentcore dev --logs`, {
          cause: err,
        })
      : err;
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
        throw new ValidationError(
          '--tool is required with call-tool. Usage: agentcore dev call-tool --tool <name> --input \'{"arg": "value"}\''
        );
      }
      const { sessionId } = await listMcpTools(port, undefined, headers);
      let args: Record<string, unknown> = {};
      if (input) {
        try {
          args = JSON.parse(input) as Record<string, unknown>;
        } catch {
          throw new ValidationError(`Invalid JSON for --input: ${input}. Expected format: --input '{"key": "value"}'`);
        }
      }
      const result = await callMcpTool(port, toolName, args, sessionId, undefined, headers);
      console.log(result);
    } else {
      throw new ValidationError(
        `Unknown MCP invoke command "${invokeValue}". Usage: agentcore dev list-tools | agentcore dev call-tool --tool <name>`
      );
    }
  } catch (err) {
    throw isConnectionRefused(err)
      ? new ConnectionError(`Dev server not running on port ${port}. Start it with: agentcore dev --logs`, {
          cause: err,
        })
      : err;
  }
}

async function execInContainer(command: string, containerName: string): Promise<void> {
  const detection = await detectContainerRuntime();
  if (!detection.runtime) {
    throw new ResourceNotFoundError('No container runtime found (docker, podman, or finch required)');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(detection.runtime!.binary, ['exec', containerName, 'bash', '-c', command], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Container exec exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

export const registerDev = (program: Command) => {
  program
    .command('dev')
    .alias('d')
    .description(COMMAND_DESCRIPTIONS.dev)
    .argument('[prompt]', 'Send a prompt to a running dev server [non-interactive]')
    .option('-p, --port <port>', 'Port for development server', '8080')
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

    .action(async (positionalPrompt: string | undefined, opts) => {
      try {
        const port = parseInt(opts.port, 10);

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
          const execResult = await withCommandRunTelemetry(
            'dev',
            {
              action: 'exec' as const,
              ui_mode: 'terminal' as const,
              has_stream: false,
              protocol: standardize(Protocol, (targetAgent?.protocol ?? 'http').toLowerCase()),
              invoke_count: 0,
            },
            async (): Promise<Result> => {
              await execInContainer(positionalPrompt, containerName);
              return { success: true };
            }
          );
          if (!execResult.success) throw execResult.error;
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
            invokePort = getAgentPort(invokeProject, opts.runtime, port);
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

          const invokeResult = await withCommandRunTelemetry(
            'dev',
            {
              action: 'invoke' as const,
              ui_mode: 'terminal' as const,
              has_stream: opts.stream ?? false,
              protocol: standardize(Protocol, protocol.toLowerCase()),
              invoke_count: 1,
            },
            async (): Promise<Result> => {
              // Protocol-aware dispatch
              if (protocol === 'MCP') {
                await handleMcpInvoke(invokePort, invokePrompt, opts.tool, opts.input, headers);
              } else if (protocol === 'A2A') {
                await invokeA2ADevServer(invokePort, invokePrompt, headers);
              } else if (protocol === 'AGUI') {
                for await (const chunk of invokeForProtocol('AGUI', {
                  port: invokePort,
                  message: invokePrompt,
                  headers,
                })) {
                  process.stdout.write(chunk);
                }
                process.stdout.write('\n');
              } else {
                await invokeDevServer(invokePort, invokePrompt, opts.stream ?? false, headers);
              }
              return { success: true };
            }
          );
          if (!invokeResult.success) throw invokeResult.error;
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

          // Calculate port: A2A/MCP use fixed framework ports, HTTP uses configurable port
          const isA2A = config.protocol === 'A2A';
          const isMcp = config.protocol === 'MCP';
          const fixedPort = isA2A ? 9000 : isMcp ? 8000 : getAgentPort(project, config.agentName, port);
          const actualPort = await findAvailablePort(fixedPort);
          if ((isA2A || isMcp) && actualPort !== fixedPort) {
            console.error(`Error: Port ${fixedPort} is in use. ${config.protocol} agents require port ${fixedPort}.`);
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

          const devResult = await withCommandRunTelemetry(
            'dev',
            {
              action: 'server' as const,
              ui_mode: 'terminal' as const,
              has_stream: false,
              protocol: standardize(Protocol, (config.protocol ?? 'http').toLowerCase()),
              invoke_count: 0,
            },
            async (): Promise<Result> => {
              await new Promise<void>((resolve, reject) => {
                const devCallbacks = {
                  onLog: (level: string, msg: string) => {
                    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '→';
                    console.log(`${prefix} ${msg}`);
                    logger.log(msg, level === 'error' ? 'error' : 'info');
                  },
                  onExit: (code: number | null) => {
                    console.log(`\nServer exited with code ${code ?? 0}`);
                    logger.finalize(code === 0);
                    if (code !== 0 && code !== null) {
                      reject(new Error(`Server exited with code ${code}`));
                    } else {
                      resolve();
                    }
                  },
                };

                const server = createDevServer(config, {
                  port: actualPort,
                  envVars: mergedEnvVars,
                  callbacks: devCallbacks,
                });
                server.start().catch(reject);

                process.once('SIGINT', () => {
                  console.log('\nStopping server...');
                  collector?.stop();
                  server.kill();
                });
              });
              return { success: true as const };
            }
          );
          if (!devResult.success) throw devResult.error;
          process.exit(0);
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

          const tuiResult = await withCommandRunTelemetry(
            'dev',
            {
              action: 'server' as const,
              ui_mode: 'terminal' as const,
              has_stream: false,
              protocol: standardize(Protocol, (targetDevAgent?.protocol ?? 'http').toLowerCase()),
              invoke_count: 0,
            },
            async (): Promise<Result> => {
              const { DevScreen } = await import('../../tui/screens/dev/DevScreen');
              const { unmount, waitUntilExit } = render(
                <LayoutProvider>
                  <DevScreen
                    onBack={() => {
                      exitAltScreen();
                      unmount();
                    }}
                    workingDir={workingDir}
                    port={port}
                    agentName={opts.runtime}
                    headers={headers}
                  />
                </LayoutProvider>
              );

              await waitUntilExit();
              exitAltScreen();
              return { success: true };
            }
          );
          if (!tuiResult.success) throw tuiResult.error;
          collector?.stop();
          process.exit(0);
        }

        // Default: launch web UI in browser
        // NOTE: Do not copy this pattern. runBrowserMode blocks forever (internal
        // await new Promise(() => {})) so we cannot use withCommandRunTelemetry here.
        // We emit telemetry eagerly before the blocking call. If startup fails, the
        // error propagates to the outer catch. Prefer withCommandRunTelemetry for
        // commands that return.
        {
          const client = await TelemetryClientAccessor.get().catch(() => undefined);
          const devAttrs = {
            action: 'server' as const,
            ui_mode: 'browser' as const,
            has_stream: false,
            protocol: standardize(Protocol, (targetDevAgent?.protocol ?? 'http').toLowerCase()),
            invoke_count: 0,
          };
          if (client) {
            await client.withCommandRun('dev', () => devAttrs);
          }
          await runBrowserMode({
            workingDir,
            project,
            port,
            agentName: opts.runtime,
            otelEnvVars,
            collector,
          });
        }
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
        process.exit(1);
      }
    });
};
