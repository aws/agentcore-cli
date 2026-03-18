import { findConfigRoot, getWorkingDirectory, readEnvFile } from '../../../lib';
import { getErrorMessage } from '../../errors';
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
  loadProjectConfig,
} from '../../operations/dev';
import { getGatewayEnvVars } from '../../operations/dev/gateway-env.js';
import { FatalError } from '../../tui/components';
import { LayoutProvider } from '../../tui/context';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
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
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function invokeA2ADevServer(port: number, prompt: string): Promise<void> {
  try {
    for await (const chunk of invokeForProtocol('A2A', { port, message: prompt })) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  } catch (err) {
    if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function handleMcpInvoke(port: number, invokeValue: string, toolName?: string, input?: string): Promise<void> {
  try {
    if (invokeValue === 'list-tools') {
      const { tools } = await listMcpTools(port);
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
        console.error('Error: --tool is required with --invoke call-tool');
        console.error('Usage: agentcore dev --invoke call-tool --tool <name> --input \'{"arg": "value"}\'');
        process.exit(1);
      }
      // Initialize session first, then call tool with the session ID
      const { sessionId } = await listMcpTools(port);
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
      const result = await callMcpTool(port, toolName, args, sessionId);
      console.log(result);
    } else {
      console.error(`Error: Unknown MCP invoke command "${invokeValue}"`);
      console.error('Usage:');
      console.error('  agentcore dev --invoke list-tools');
      console.error('  agentcore dev --invoke call-tool --tool <name> --input \'{"arg": "value"}\'');
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
      console.error(`Error: Dev server not running on port ${port}`);
      console.error('Start it with: agentcore dev');
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
    .option('-i, --invoke <prompt>', 'Invoke running dev server (use --agent if multiple) [non-interactive]')
    .option('-s, --stream', 'Stream response when using --invoke [non-interactive]')
    .option('-l, --logs', 'Run dev server with logs to stdout [non-interactive]')
    .option('--tool <name>', 'MCP tool name (used with --invoke call-tool)')
    .option('--input <json>', 'MCP tool arguments as JSON (used with --invoke call-tool)')
    .action(async opts => {
      try {
        const port = parseInt(opts.port, 10);

        // If --invoke provided, call the dev server and exit
        if (opts.invoke) {
          const invokeProject = await loadProjectConfig(getWorkingDirectory());

          // Determine which agent/port to invoke
          let invokePort = port;
          let targetAgent = invokeProject?.agents[0];
          if (opts.agent && invokeProject) {
            invokePort = getAgentPort(invokeProject, opts.agent, port);
            targetAgent = invokeProject.agents.find(a => a.name === opts.agent);
          } else if (invokeProject && invokeProject.agents.length > 1 && !opts.agent) {
            const names = invokeProject.agents.map(a => a.name).join(', ');
            console.error(`Error: Multiple agents found. Use --agent to specify which one.`);
            console.error(`Available: ${names}`);
            process.exit(1);
          }

          const protocol = targetAgent?.protocol ?? 'HTTP';

          // Override port for protocols with fixed framework ports
          if (protocol === 'A2A') invokePort = 9000;
          else if (protocol === 'MCP') invokePort = 8000;

          // Show model info if available (not applicable to MCP)
          if (protocol !== 'MCP' && targetAgent?.modelProvider) {
            console.log(`Provider: ${targetAgent.modelProvider}`);
          }

          // Protocol-aware dispatch
          if (protocol === 'MCP') {
            await handleMcpInvoke(invokePort, opts.invoke, opts.tool, opts.input);
          } else if (protocol === 'A2A') {
            await invokeA2ADevServer(invokePort, opts.invoke);
          } else {
            await invokeDevServer(invokePort, opts.invoke, opts.stream ?? false);
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

        if (!project.agents || project.agents.length === 0) {
          render(<FatalError message="No agents defined in project." suggestedCommand="agentcore add agent" />);
          process.exit(1);
        }

        // Warn about VPC mode limitations in local dev
        const targetDevAgent = opts.agent ? project.agents.find(a => a.name === opts.agent) : project.agents[0];
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

        // If --logs provided, run non-interactive mode
        if (opts.logs) {
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
          const gatewayEnvVars = await getGatewayEnvVars();
          // Gateway env vars go first, .env.local overrides take precedence
          const mergedEnvVars = { ...gatewayEnvVars, ...envVars };
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
          const targetAgent = project.agents.find(a => a.name === config.agentName);
          const providerInfo = targetAgent?.modelProvider ?? '(see agent code)';

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
            server.kill();
          });

          // Keep process alive
          // eslint-disable-next-line @typescript-eslint/no-empty-function
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
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
