import {
  ConnectionError,
  NoProjectError,
  ResourceNotFoundError,
  ValidationError,
  findConfigRoot,
  getWorkingDirectory,
} from '../../../lib';
import { failureResult } from '../../../lib/result.js';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { detectContainerRuntime } from '../../external-requirements';
import { isPreviewEnabled } from '../../feature-flags';
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
  onShutdownSignal,
} from '../../operations/dev';
import { OtelCollector, startOtelCollector } from '../../operations/dev/otel';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { AgentProtocol, standardize } from '../../telemetry/schemas/common-shapes.js';
import { LayoutProvider } from '../../tui/context';
import { requireProject, requireTTY } from '../../tui/guards';
import { runCliDeploy } from '../deploy/progress';
import { parseHeaderFlags } from '../shared/header-utils';
import { launchTuiDevScreenWithPicker, runBrowserMode } from './browser-mode';
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
    .option('--skip-deploy', 'Skip automatic resource deployment before starting dev server [preview]')
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
          const execResult = await withCommandRunTelemetry(
            'dev',
            {
              agent_environment: 'runtime' as const,
              dev_action: 'exec' as const,
              ui_mode: 'terminal' as const,
              has_stream: false,
              agent_protocol: standardize(AgentProtocol, 'unknown'),
              invoke_count: 0,
            },
            async recorder => {
              if (!positionalPrompt) {
                return failureResult(
                  new ValidationError('A command is required with --exec. Usage: agentcore dev --exec "whoami"')
                );
              }
              const workingDir = getWorkingDirectory();
              const project = await loadProjectConfig(workingDir);
              const agentName = opts.runtime ?? project?.runtimes[0]?.name ?? 'unknown';
              const targetAgent = project?.runtimes.find(a => a.name === agentName);
              if (targetAgent?.build !== 'Container') {
                return failureResult(
                  new ValidationError(
                    '--exec is only supported for Container build agents. For CodeZip agents, use your terminal to run commands directly.'
                  )
                );
              }
              recorder.set({
                agent_protocol: standardize(AgentProtocol, (targetAgent?.protocol ?? 'http').toLowerCase()),
              });
              const containerName = `agentcore-dev-${agentName}`.toLowerCase();
              await execInContainer(positionalPrompt, containerName);
              return { success: true as const };
            }
          );
          if (!execResult.success) throw execResult.error;
          return;
        }

        // If a prompt is provided, invoke a running dev server
        const invokePrompt = positionalPrompt;
        if (invokePrompt !== undefined) {
          const invokeResult = await withCommandRunTelemetry(
            'dev',
            {
              agent_environment: 'runtime' as const,
              dev_action: 'invoke' as const,
              ui_mode: 'terminal' as const,
              has_stream: opts.stream ?? false,
              agent_protocol: standardize(AgentProtocol, 'unknown'),
              invoke_count: 1,
            },
            async recorder => {
              const workingDir = getWorkingDirectory();
              const invokeProject = await loadProjectConfig(workingDir);

              let invokePort = port;
              let targetAgent = invokeProject?.runtimes[0];
              if (opts.runtime && invokeProject) {
                invokePort = getAgentPort(invokeProject, opts.runtime, port);
                targetAgent = invokeProject.runtimes.find(a => a.name === opts.runtime);
              } else if (invokeProject && invokeProject.runtimes.length > 1 && !opts.runtime) {
                const names = invokeProject.runtimes.map(a => a.name).join(', ');
                throw new ValidationError(
                  `Multiple runtimes found. Use --runtime to specify which one. Available: ${names}`
                );
              }

              const protocol = targetAgent?.protocol ?? 'HTTP';
              recorder.set({
                agent_protocol: standardize(AgentProtocol, protocol.toLowerCase()),
              });

              if (protocol === 'A2A') invokePort = 9000;
              else if (protocol === 'MCP') invokePort = 8000;

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

              return { success: true as const };
            }
          );
          // TODO: Remove cast once withCommandRunTelemetry's return type is narrowed
          if (!invokeResult.success) throw (invokeResult as unknown as { error: Error }).error;
          return;
        }

        requireProject();

        const workingDir = getWorkingDirectory();

        const serverResult = await withCommandRunTelemetry(
          'dev',
          {
            agent_environment: 'runtime' as const,
            dev_action: 'server' as const,
            ui_mode: 'terminal' as const,
            has_stream: false,
            agent_protocol: standardize(AgentProtocol, 'unknown'),
            invoke_count: 0,
          },
          async recorder => {
            const project = await loadProjectConfig(workingDir);
            if (!project) {
              throw new NoProjectError();
            }

            const hasRuntimes = project.runtimes && project.runtimes.length > 0;
            const hasHarnesses = isPreviewEnabled() && project.harnesses && project.harnesses.length > 0;

            if (!hasRuntimes && !hasHarnesses) {
              throw new ValidationError(
                'No agents or harnesses defined in project. Run `agentcore add agent` to fix this.'
              );
            }

            const targetDevAgent = opts.runtime
              ? project.runtimes.find(a => a.name === opts.runtime)
              : project.runtimes[0];
            if (targetDevAgent?.networkMode === 'VPC') {
              console.log(
                '\x1b[33mWarning: This agent uses VPC network mode. Local dev server runs outside your VPC. Network behavior may differ from deployed environment.\x1b[0m\n'
              );
            }

            const supportedAgents = getDevSupportedAgents(project);
            if (supportedAgents.length === 0 && !hasHarnesses) {
              throw new ValidationError(
                'No agents support dev mode. Dev mode requires an agent with an entrypoint or a harness.'
              );
            }

            const configRoot = findConfigRoot(workingDir);
            let otelEnvVars: Record<string, string> = {};
            let collector: OtelCollector | undefined;

            if (opts.traces !== false) {
              const persistTracesDir = path.join(configRoot ?? workingDir, '.cli', 'traces');
              const otelResult = await startOtelCollector(persistTracesDir);
              collector = otelResult.collector;
              otelEnvVars = otelResult.otelEnvVars;
            }

            // --logs: non-interactive server mode
            if (opts.logs) {
              // Preview: harness-only projects need deploy then print invoke instructions
              if (isPreviewEnabled() && supportedAgents.length === 0 && hasHarnesses) {
                recorder.set({ agent_environment: 'harness' as const });
                if (!opts.skipDeploy) {
                  await runCliDeploy();
                }
                const harnessNames = (project.harnesses ?? []).map(h => h.name);
                console.log('Harness dev runs against the deployed service (no local server).');
                console.log(`If you changed the harness config, redeploy to pick up changes: agentcore deploy`);
                console.log(`\nInvoke your harness:`);
                for (const name of harnessNames) {
                  console.log(`  agentcore invoke --harness ${name} "your prompt"`);
                }
                console.log(`\nOr use the interactive TUI: agentcore dev`);
                return { success: true as const, blockingPromise: Promise.resolve() };
              }

              if (project.runtimes.length > 1 && !opts.runtime) {
                const names = project.runtimes.map(a => a.name).join(', ');
                throw new ValidationError(
                  `Multiple runtimes found. Use --runtime to specify which one. Available: ${names}`
                );
              }

              const agentName = opts.runtime ?? project.runtimes[0]?.name;
              const { envVars } = await loadDevEnv(workingDir);
              const mergedEnvVars = { ...envVars, ...otelEnvVars };
              const config = getDevConfig(workingDir, project, configRoot ?? undefined, agentName);

              if (!config) {
                throw new ValidationError('No dev-supported agents found.');
              }

              recorder.set({
                agent_protocol: standardize(AgentProtocol, config.protocol.toLowerCase()),
              });

              const isA2A = config.protocol === 'A2A';
              const isMcp = config.protocol === 'MCP';
              const fixedPort = isA2A ? 9000 : isMcp ? 8000 : getAgentPort(project, config.agentName, port);
              const actualPort = await findAvailablePort(fixedPort);
              if ((isA2A || isMcp) && actualPort !== fixedPort) {
                throw new ValidationError(
                  `Port ${fixedPort} is in use. ${config.protocol} agents require port ${fixedPort}.`
                );
              }

              // Deploy resources before starting dev server (preview mode with harnesses)
              if (isPreviewEnabled() && !opts.skipDeploy && hasHarnesses) {
                await runCliDeploy();
              }

              const logger = new ExecLogger({ command: 'dev' });

              if (actualPort !== fixedPort) {
                console.log(`Port ${fixedPort} in use, using ${actualPort}`);
              }

              console.log(`Starting dev server...`);
              console.log(`Agent: ${config.agentName}`);
              if (config.protocol !== 'MCP') {
                console.log(`Provider: (see agent code)`);
              }
              if (config.protocol !== 'HTTP') {
                console.log(`Protocol: ${config.protocol}`);
              }
              console.log(`Server: ${getEndpointUrl(actualPort, config.protocol)}`);
              console.log(`Log: ${logger.getRelativeLogPath()}`);
              console.log(`Press Ctrl+C to stop\n`);

              const serverPromise = new Promise<void>((resolve, reject) => {
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

                onShutdownSignal(() => {
                  console.log('\nStopping server...');
                  collector?.stop();
                  server.kill();
                });
              });

              return { success: true as const, blockingPromise: serverPromise };
            }
            recorder.set({
              agent_protocol: standardize(AgentProtocol, (targetDevAgent?.protocol ?? 'http').toLowerCase()),
            });

            // --no-browser: terminal TUI mode
            if (!opts.browser) {
              requireTTY();
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
                    }}
                    workingDir={workingDir}
                    port={port}
                    agentName={opts.runtime}
                    headers={headers}
                    skipDeploy={opts.skipDeploy}
                  />
                </LayoutProvider>
              );

              process.once('SIGTERM', () => {
                exitAltScreen();
                unmount();
              });

              return {
                success: true as const,
                blockingPromise: waitUntilExit().finally(() => {
                  exitAltScreen();
                  collector?.stop();
                }),
              };
            }

            // Preview: show TUI deploy progress, then launch Agent Inspector in the browser
            if (isPreviewEnabled()) {
              const pickerResult = await launchTuiDevScreenWithPicker(workingDir, {
                skipDeploy: opts.skipDeploy,
              });

              if (pickerResult != null) {
                recorder.set({ ui_mode: 'browser' as const });
                return {
                  success: true as const,
                  blockingPromise: runBrowserMode({
                    workingDir,
                    project,
                    port,
                    agentName: pickerResult.agentName,
                    harnessName: pickerResult.harnessName,
                    otelEnvVars,
                    collector,
                  }),
                };
              }
              return { success: true as const, blockingPromise: Promise.resolve() };
            }

            // Default: browser mode (blocks forever)
            recorder.set({ ui_mode: 'browser' as const });
            return {
              success: true as const,
              blockingPromise: runBrowserMode({
                workingDir,
                project,
                port,
                agentName: opts.runtime,
                otelEnvVars,
                collector,
              }),
            };
          }
        );
        // TODO: Remove cast once withCommandRunTelemetry's return type is narrowed
        if (!serverResult.success) throw (serverResult as unknown as { error: Error }).error;
        await serverResult.blockingPromise;
        process.exit(0);
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
        process.exit(1);
      }
    });
};
