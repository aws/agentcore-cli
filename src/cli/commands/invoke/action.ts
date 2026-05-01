import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import {
  buildAguiRunInput,
  executeBashCommand,
  invokeA2ARuntime,
  invokeAgentRuntime,
  invokeAgentRuntimeStreaming,
  invokeAguiRuntime,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
} from '../../aws';
import { invokeHarness } from '../../aws/agentcore-harness';
import { InvokeLogger } from '../../logging';
import { formatMcpToolList } from '../../operations/dev/utils';
import {
  canFetchHarnessToken,
  canFetchRuntimeToken,
  fetchHarnessToken,
  fetchRuntimeToken,
} from '../../operations/fetch-access';
import { generateSessionId } from '../../operations/session';
import type { InvokeOptions, InvokeResult } from './types';
import { randomUUID } from 'node:crypto';

const TOOL_TYPE_DEFAULT_NAMES: Record<string, string> = {
  agentcore_browser: 'browser',
  agentcore_code_interpreter: 'code-interpreter',
};

export interface InvokeContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

/**
 * Loads configuration required for invocation
 */
export async function loadInvokeConfig(configIO: ConfigIO = new ConfigIO()): Promise<InvokeContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

/**
 * Main invoke handler
 */
export async function handleInvoke(context: InvokeContext, options: InvokeOptions = {}): Promise<InvokeResult> {
  const { project, deployedState, awsTargets } = context;

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // ── Route to harness or runtime ─────────────────────────────────────────
  const harnessEntries = project.harnesses ?? [];
  const hasBoth = project.runtimes.length > 0 && harnessEntries.length > 0;

  if (hasBoth && !options.harnessName && !options.agentName) {
    const allNames = [
      ...project.runtimes.map(r => `--runtime ${r.name}`),
      ...harnessEntries.map(h => `--harness ${h.name}`),
    ];
    return {
      success: false,
      error: `Project has both runtimes and harnesses. Specify one:\n  ${allNames.join('\n  ')}`,
    };
  }

  const isHarnessInvoke = options.harnessName != null || (harnessEntries.length > 0 && project.runtimes.length === 0);

  if (isHarnessInvoke) {
    return handleHarnessInvoke(project, targetState, targetConfig, selectedTargetName, options);
  }

  // ── Runtime invoke path ────────────────────────────────────────────────
  if (project.runtimes.length === 0) {
    return { success: false, error: 'No runtimes or harnesses defined in configuration' };
  }

  // Resolve agent
  const agentNames = project.runtimes.map(a => a.name);

  if (!options.agentName && project.runtimes.length > 1) {
    return { success: false, error: `Multiple runtimes found. Use --runtime to specify one: ${agentNames.join(', ')}` };
  }

  const agentSpec = options.agentName ? project.runtimes.find(a => a.name === options.agentName) : project.runtimes[0];

  if (options.agentName && !agentSpec) {
    return { success: false, error: `Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}` };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Warn about VPC mode endpoint requirements
  if (agentSpec.networkMode === 'VPC') {
    console.log(
      '\x1b[33mWarning: This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.\x1b[0m'
    );
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    return { success: false, error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
  }

  // Build config bundle baggage if a bundle is associated with this agent
  const deployedBundles = targetState?.resources?.configBundles ?? {};
  let baggage: string | undefined;
  const bundleSpec = project.configBundles?.find(b => {
    const keys = Object.keys(b.components ?? {});
    return keys.some(k => k === `{{runtime:${agentSpec.name}}}`);
  });
  if (bundleSpec) {
    const bundleState = deployedBundles[bundleSpec.name];
    if (bundleState?.bundleArn && bundleState?.versionId) {
      baggage = `aws.agentcore.configbundle_arn=${encodeURIComponent(bundleState.bundleArn)},aws.agentcore.configbundle_version=${encodeURIComponent(bundleState.versionId)}`;
    }
  }

  // Auto-fetch bearer token for CUSTOM_JWT agents when not provided
  if (agentSpec.authorizerType === 'CUSTOM_JWT' && !options.bearerToken) {
    const canFetch = await canFetchRuntimeToken(agentSpec.name);
    if (canFetch) {
      try {
        const tokenResult = await fetchRuntimeToken(agentSpec.name, { deployTarget: selectedTargetName });
        options = { ...options, bearerToken: tokenResult.token };
      } catch (err) {
        return {
          success: false,
          error: `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
        };
      }
    } else {
      return {
        success: false,
        error: `Agent '${agentSpec.name}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the agent with --client-id and --client-secret to enable auto-fetch.`,
      };
    }
  }

  // When invoking with a bearer token (OAuth/CUSTOM_JWT), AgentCore does not
  // auto-generate a runtime session ID the way it does for SigV4 callers. Templates
  // that wire up AgentCoreMemorySessionManager require a non-null session_id, so
  // generate one here if the caller didn't pass --session-id.
  if (options.bearerToken && !options.sessionId) {
    options = { ...options, sessionId: generateSessionId() };
  }

  // Exec mode: run shell command in runtime container
  if (options.exec) {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: agentState.runtimeArn,
      region: targetConfig.region,
      sessionId: options.sessionId,
    });
    const command = options.prompt;
    if (!command) {
      return { success: false, error: '--exec requires a command (prompt)' };
    }
    logger.logPrompt(command, options.sessionId, options.userId);

    try {
      const result = await executeBashCommand({
        region: targetConfig.region,
        runtimeArn: agentState.runtimeArn,
        command,
        sessionId: options.sessionId,
        timeout: options.timeout,
        headers: options.headers,
        bearerToken: options.bearerToken,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | undefined;
      let status: string | undefined;

      for await (const event of result.stream) {
        switch (event.type) {
          case 'stdout':
            if (event.data) {
              stdout += event.data;
              if (!options.json) {
                process.stdout.write(event.data);
              }
            }
            break;
          case 'stderr':
            if (event.data) {
              stderr += event.data;
              if (!options.json) {
                process.stderr.write(event.data);
              }
            }
            break;
          case 'stop':
            exitCode = event.exitCode;
            status = event.status;
            break;
        }
      }

      logger.logResponse(stdout || stderr || `exit code: ${exitCode}`);

      if (options.json) {
        return {
          success: exitCode === 0,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode === undefined) {
        return {
          success: false,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          error: 'Command stream ended without exit code',
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          error: `Command exited with code ${exitCode}${status === 'TIMED_OUT' ? ' (timed out)' : ''}`,
          logFilePath: logger.logFilePath,
        };
      }

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'exec command failed');
      throw err;
    }
  }

  // MCP protocol handling
  if (agentSpec.protocol === 'MCP') {
    const mcpOpts = {
      region: targetConfig.region,
      runtimeArn: agentState.runtimeArn,
      userId: options.userId,
      headers: options.headers,
      bearerToken: options.bearerToken,
      baggage,
    };

    // list-tools: list available MCP tools
    if (options.prompt === 'list-tools') {
      try {
        const result = await mcpListTools(mcpOpts);
        const response = formatMcpToolList(result.tools);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to list MCP tools: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // call-tool: call an MCP tool by name
    if (options.prompt === 'call-tool') {
      if (!options.tool) {
        return {
          success: false,
          error: 'MCP call-tool requires --tool <name>. Use "list-tools" to see available tools.',
        };
      }
      let args: Record<string, unknown> = {};
      if (options.input) {
        try {
          args = JSON.parse(options.input) as Record<string, unknown>;
        } catch {
          return { success: false, error: `Invalid JSON for --input: ${options.input}` };
        }
      }
      try {
        // Lightweight init to get session ID (no tools/list round-trip)
        const mcpSessionId = await mcpInitSession(mcpOpts);
        const response = await mcpCallTool({ ...mcpOpts, mcpSessionId }, options.tool, args);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to call MCP tool: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!options.prompt) {
      return {
        success: false,
        error:
          'MCP agents require a command. Usage:\n  agentcore invoke list-tools\n  agentcore invoke call-tool --tool <name> --input \'{"arg": "value"}\'',
      };
    }
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke "your prompt"' };
  }

  // A2A protocol handling — send JSON-RPC message/send via InvokeAgentRuntime
  if (agentSpec.protocol === 'A2A') {
    try {
      const a2aResult = await invokeA2ARuntime(
        {
          region: targetConfig.region,
          runtimeArn: agentState.runtimeArn,
          userId: options.userId,
          sessionId: options.sessionId,
          headers: options.headers,
        },
        options.prompt
      );
      let response = '';
      for await (const chunk of a2aResult.stream) {
        response += chunk;
        if (options.stream) {
          process.stdout.write(chunk);
        }
      }
      if (options.stream) {
        process.stdout.write('\n');
      }
      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response,
      };
    } catch (err) {
      return { success: false, error: `A2A invoke failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // AGUI protocol handling — send RunAgentInput via InvokeAgentRuntime, stream text
  if (agentSpec.protocol === 'AGUI') {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: agentState.runtimeArn,
      region: targetConfig.region,
    });

    try {
      const aguiInput = buildAguiRunInput(options.prompt, options.sessionId);
      logger.logPrompt(options.prompt, undefined, options.userId);

      const aguiResult = await invokeAguiRuntime(
        {
          region: targetConfig.region,
          runtimeArn: agentState.runtimeArn,
          sessionId: options.sessionId,
          userId: options.userId,
          logger,
          headers: options.headers,
          bearerToken: options.bearerToken,
        },
        aguiInput
      );
      let response = '';
      let hasError = false;
      for await (const chunk of aguiResult.textStream) {
        response += chunk;
        if (chunk.startsWith('Error: ')) {
          hasError = true;
        }
        if (options.stream) {
          process.stdout.write(chunk);
        }
      }
      if (options.stream) {
        process.stdout.write('\n');
      }

      logger.logResponse(response);

      return {
        success: !hasError,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response,
        sessionId: aguiResult.sessionId,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'AGUI invoke failed');
      return { success: false, error: `AGUI invoke failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Create logger for this invocation
  const logger = new InvokeLogger({
    agentName: agentSpec.name,
    runtimeArn: agentState.runtimeArn,
    region: targetConfig.region,
    sessionId: options.sessionId,
  });

  logger.logPrompt(options.prompt, options.sessionId, options.userId);

  if (options.stream) {
    // Streaming mode
    let fullResponse = '';
    try {
      const result = await invokeAgentRuntimeStreaming({
        region: targetConfig.region,
        runtimeArn: agentState.runtimeArn,
        payload: options.prompt,
        sessionId: options.sessionId,
        userId: options.userId,
        logger,
        headers: options.headers,
        bearerToken: options.bearerToken,
        baggage,
      });

      for await (const chunk of result.stream) {
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');

      logger.logResponse(fullResponse);

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response: fullResponse,
        sessionId: result.sessionId,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'invoke streaming failed');
      throw err;
    }
  }

  // Non-streaming mode
  const response = await invokeAgentRuntime({
    region: targetConfig.region,
    runtimeArn: agentState.runtimeArn,
    payload: options.prompt,
    sessionId: options.sessionId,
    userId: options.userId,
    headers: options.headers,
    bearerToken: options.bearerToken,
    baggage,
  });

  logger.logResponse(response.content);

  return {
    success: true,
    agentName: agentSpec.name,
    targetName: selectedTargetName,
    response: response.content,
    sessionId: response.sessionId,
    logFilePath: logger.logFilePath,
  };
}

// ============================================================================
// Harness Invoke
// ============================================================================

async function handleHarnessInvoke(
  project: AgentCoreProjectSpec,
  targetState: DeployedState['targets'][string] | undefined,
  targetConfig: { region: string; name: string },
  selectedTargetName: string,
  options: InvokeOptions
): Promise<InvokeResult> {
  const harnessEntries = project.harnesses ?? [];

  if (harnessEntries.length === 0) {
    return { success: false, error: 'No harnesses defined in configuration' };
  }

  // Resolve harness name — explicit flag, or auto-infer if only one
  let harnessName = options.harnessName;
  if (!harnessName) {
    if (harnessEntries.length > 1) {
      const names = harnessEntries.map(h => h.name);
      return {
        success: false,
        error: `Multiple harnesses found. Use --harness to specify one: ${names.join(', ')}`,
      };
    }
    harnessName = harnessEntries[0]!.name;
  }

  const harnessEntry = harnessEntries.find(h => h.name === harnessName);
  if (!harnessEntry) {
    const names = harnessEntries.map(h => h.name);
    return {
      success: false,
      error: `Harness '${harnessName}' not found. Available: ${names.join(', ')}`,
    };
  }

  // Get deployed state for this harness
  const harnessState = targetState?.resources?.harnesses?.[harnessName];
  if (!harnessState) {
    return {
      success: false,
      error: `Harness '${harnessName}' is not deployed to target '${selectedTargetName}'. Run \`agentcore deploy\` first.`,
    };
  }

  // Read harness spec for auth config
  const configIO = new ConfigIO();
  let harnessSpec;
  try {
    harnessSpec = await configIO.readHarnessSpec(harnessName);
  } catch {
    // If we can't read the spec, continue without auto-fetch
  }

  // Auto-fetch bearer token for CUSTOM_JWT harnesses when not provided
  if (harnessSpec?.authorizerType === 'CUSTOM_JWT' && !options.bearerToken) {
    const canFetch = await canFetchHarnessToken(harnessName);
    if (canFetch) {
      try {
        const tokenResult = await fetchHarnessToken(harnessName, { deployTarget: selectedTargetName });
        options = { ...options, bearerToken: tokenResult.token };
      } catch (err) {
        return {
          success: false,
          error: `CUSTOM_JWT harness requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
        };
      }
    } else {
      return {
        success: false,
        error: `Harness '${harnessName}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the harness with --client-id and --client-secret to enable auto-fetch.`,
      };
    }
  }

  // Exec mode: run shell command on harness VM via InvokeAgentRuntimeCommand
  if (options.exec) {
    const command = options.prompt;
    if (!command) {
      return {
        success: false,
        error: '--exec requires a command. Usage: agentcore invoke --exec --harness <name> "ls -la"',
      };
    }

    try {
      const result = await executeBashCommand({
        region: targetConfig.region,
        runtimeArn: harnessState.harnessArn,
        command,
        sessionId: options.sessionId,
        timeout: options.timeout,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | undefined;
      let status: string | undefined;

      for await (const event of result.stream) {
        switch (event.type) {
          case 'stdout':
            if (event.data) {
              stdout += event.data;
              if (!options.json) process.stdout.write(event.data);
            }
            break;
          case 'stderr':
            if (event.data) {
              stderr += event.data;
              if (!options.json) process.stderr.write(event.data);
            }
            break;
          case 'stop':
            exitCode = event.exitCode;
            status = event.status;
            break;
        }
      }

      if (options.json) {
        return {
          success: exitCode === 0,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          targetName: selectedTargetName,
          error: `Command exited with code ${exitCode}${status === 'TIMED_OUT' ? ' (timed out)' : ''}`,
        };
      }

      return { success: true, targetName: selectedTargetName };
    } catch (err) {
      return { success: false, error: `Exec failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke --harness <name> "your prompt"' };
  }

  const sessionId = options.sessionId ?? randomUUID();
  const region = targetConfig.region;

  const logger = new InvokeLogger({
    agentName: harnessName,
    runtimeArn: harnessState.harnessArn,
    region,
    sessionId,
  });
  logger.logPrompt(options.prompt, sessionId, options.userId);

  let fullResponse = '';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const cyan = '\x1b[36m';

  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerInterval: NodeJS.Timeout | undefined;
  let spinnerIdx = 0;
  if (!options.json && !options.verbose) {
    process.stderr.write(`${dim}${SPINNER[0]} Thinking...${reset}`);
    spinnerInterval = setInterval(() => {
      spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
      process.stderr.write(`\r${dim}${SPINNER[spinnerIdx]} Thinking...${reset}`);
    }, 80);
  }

  let spinnerCleared = false;
  const clearSpinner = () => {
    if (spinnerInterval && !spinnerCleared) {
      clearInterval(spinnerInterval);
      spinnerCleared = true;
      process.stderr.write('\r\x1b[K');
    }
  };

  try {
    const messages: { role: string; content: Record<string, unknown>[] }[] = [
      { role: 'user', content: [{ text: options.prompt }] },
    ];

    const baseOpts: Partial<import('../../aws/agentcore-harness').InvokeHarnessOptions> = {};
    if (options.modelId || options.modelProvider || options.apiKeyArn) {
      const provider = options.modelProvider ?? harnessSpec?.model?.provider;
      const modelId = options.modelId ?? harnessSpec?.model?.modelId ?? '';
      const apiKeyArn = options.apiKeyArn ?? harnessSpec?.model?.apiKeyArn;
      switch (provider) {
        case 'open_ai':
          baseOpts.model = { openAiModelConfig: { modelId, ...(apiKeyArn && { apiKeyArn }) } };
          break;
        case 'gemini':
          baseOpts.model = { geminiModelConfig: { modelId, ...(apiKeyArn && { apiKeyArn }) } };
          break;
        default:
          baseOpts.model = { bedrockModelConfig: { modelId } };
          break;
      }
    }
    if (options.tools) {
      baseOpts.tools = options.tools.split(',').map(t => {
        const type = t.trim();
        return { type, name: TOOL_TYPE_DEFAULT_NAMES[type] ?? type };
      });
    }
    if (options.maxIterations != null) baseOpts.maxIterations = options.maxIterations;
    if (options.maxTokens != null) baseOpts.maxTokens = options.maxTokens;
    if (options.harnessTimeout != null) baseOpts.timeoutSeconds = options.harnessTimeout;
    if (options.skills) baseOpts.skills = options.skills.split(',').map(p => ({ path: p.trim() }));
    if (options.systemPrompt) baseOpts.systemPrompt = [{ text: options.systemPrompt }];
    if (options.allowedTools) baseOpts.allowedTools = options.allowedTools.split(',').map(t => t.trim());
    if (options.actorId) baseOpts.actorId = options.actorId;

    let pendingToolUseId: string | undefined;
    let pendingToolName: string | undefined;
    let pendingToolInput = '';

    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      const stream = invokeHarness({
        region,
        harnessArn: harnessState.harnessArn,
        runtimeSessionId: sessionId,
        messages,
        bearerToken: options.bearerToken,
        ...baseOpts,
      });

      pendingToolUseId = undefined;
      pendingToolName = undefined;
      pendingToolInput = '';

      for await (const event of stream) {
        if (options.verbose) {
          clearSpinner();
          console.log(JSON.stringify(event));
          continue;
        }

        switch (event.type) {
          case 'contentBlockDelta':
            if (event.delta.type === 'text') {
              clearSpinner();
              fullResponse += event.delta.text;
              if (!options.json) {
                process.stdout.write(event.delta.text);
              }
            } else if (event.delta.type === 'toolUse') {
              pendingToolInput += event.delta.input;
            } else if (event.delta.type === 'toolResult') {
              const results = event.delta.results;
              for (const r of results) {
                const text = (r.text as string) ?? (r.json ? JSON.stringify(r.json) : '');
                if (text) {
                  logger.logInfo(`Tool output: ${text.slice(0, 200)}`);
                }
              }
            }
            break;
          case 'contentBlockStart':
            if (event.start.type === 'toolUse') {
              pendingToolUseId = event.start.toolUse.toolUseId;
              pendingToolName = event.start.toolUse.name;
              pendingToolInput = '';
              logger.logInfo(`Tool call: ${pendingToolName} (id: ${pendingToolUseId})`);
              if (!options.json) {
                const serverName = event.start.toolUse.serverName;
                const label = serverName ? `${serverName}/${pendingToolName}` : pendingToolName;
                process.stderr.write(`\n${dim}🔧 Tool: ${label}${reset}\n`);
              }
            } else if (event.start.type === 'toolResult') {
              const status = event.start.toolResult.status ?? 'success';
              logger.logInfo(`Tool result (${pendingToolName}): status=${status}`);
              if (!options.json) {
                const icon = status === 'error' ? '❌' : '✓';
                process.stderr.write(`${dim}  ${icon} `);
              }
            }
            break;
          case 'messageStop':
            if (event.stopReason === 'tool_use' && pendingToolUseId) {
              clearSpinner();
              let inputObj: Record<string, unknown> = {};
              try {
                inputObj = JSON.parse(pendingToolInput) as Record<string, unknown>;
              } catch {
                // use empty
              }
              logger.logInfo(`Tool input (${pendingToolName}): ${JSON.stringify(inputObj)}`);
            } else if (event.stopReason === 'tool_result') {
              if (!options.json) {
                process.stderr.write(`${reset}\n`);
              }
            } else if (!options.json) {
              process.stdout.write('\n');
            }
            break;
          case 'metadata':
            logger.logInfo(
              `Tokens: ${event.usage.inputTokens} in, ${event.usage.outputTokens} out | Latency: ${event.metrics.latencyMs}ms`
            );
            if (!options.json) {
              const { inputTokens, outputTokens } = event.usage;
              const latency = (event.metrics.latencyMs / 1000).toFixed(1);
              process.stderr.write(
                `\n${dim}⚡ ${cyan}${inputTokens}${dim} in · ${cyan}${outputTokens}${dim} out · ${cyan}${latency}s${reset}\n`
              );
              process.stderr.write(
                `${dim}🔗 Session: ${cyan}${sessionId}${dim} (use --session-id to continue)${reset}\n`
              );
            }
            break;
          case 'error':
            clearSpinner();
            logger.logError(new Error(`${event.errorType}: ${event.message}`), 'stream error');
            if (options.json) {
              return { success: false, error: `${event.errorType}: ${event.message}` };
            }
            process.stderr.write(`\nError: ${event.message}\n`);
            break;
        }
      }
    }

    logger.logResponse(fullResponse);

    if (options.json) {
      return {
        success: true,
        targetName: selectedTargetName,
        response: JSON.stringify({ text: fullResponse, sessionId }),
        logFilePath: logger.logFilePath,
      };
    }

    return { success: true, targetName: selectedTargetName, logFilePath: logger.logFilePath };
  } catch (err) {
    clearSpinner();
    logger.logError(err, 'harness invoke failed');
    return {
      success: false,
      error: `Harness invoke failed: ${err instanceof Error ? err.message : String(err)}`,
      logFilePath: logger.logFilePath,
    };
  }
}
