import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { AddFlow } from '../../tui/screens/add/AddFlow';
import { handleAddAgent, handleAddGateway, handleAddIdentity, handleAddMcpTool, handleAddMemory } from './actions';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddIdentityOptions,
  AddMcpToolOptions,
  AddMemoryOptions,
} from './types';
import {
  validateAddAgentOptions,
  validateAddGatewayOptions,
  validateAddIdentityOptions,
  validateAddMcpToolOptions,
  validateAddMemoryOptions,
} from './validate';
import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

async function handleAddAgentCLI(options: AddAgentOptions): Promise<void> {
  const validation = validateAddAgentOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAddAgent({
    name: options.name!,
    type: options.type! ?? 'create',
    buildType: (options.build as 'CodeZip' | 'Container') ?? 'CodeZip',
    language: options.language!,
    framework: options.framework!,
    modelProvider: options.modelProvider!,
    apiKey: options.apiKey,
    memory: options.memory,
    codeLocation: options.codeLocation,
    entrypoint: options.entrypoint,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added agent '${result.agentName}'`);
    if (result.agentPath) {
      console.log(`Agent code: ${result.agentPath}`);
    }
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// Gateway disabled - rename to _handleAddGatewayCLI until feature is re-enabled
async function _handleAddGatewayCLI(options: AddGatewayOptions): Promise<void> {
  const validation = validateAddGatewayOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAddGateway({
    name: options.name!,
    description: options.description,
    authorizerType: options.authorizerType ?? 'NONE',
    discoveryUrl: options.discoveryUrl,
    allowedAudience: options.allowedAudience,
    allowedClients: options.allowedClients,
    agents: options.agents,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added gateway '${result.gatewayName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// MCP Tool disabled - prefix with underscore until feature is re-enabled
async function _handleAddMcpToolCLI(options: AddMcpToolOptions): Promise<void> {
  const validation = validateAddMcpToolOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAddMcpTool({
    name: options.name!,
    description: options.description,
    language: options.language! as 'Python' | 'TypeScript',
    exposure: options.exposure!,
    agents: options.agents,
    gateway: options.gateway,
    host: options.host,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added MCP tool '${result.toolName}'`);
    if (result.sourcePath) {
      console.log(`Tool code: ${result.sourcePath}`);
    }
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// v2: Memory is a top-level resource (no owner/user)
async function handleAddMemoryCLI(options: AddMemoryOptions): Promise<void> {
  const validation = validateAddMemoryOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAddMemory({
    name: options.name!,
    strategies: options.strategies,
    expiry: options.expiry,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added memory '${result.memoryName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// v2: Identity/Credential is a top-level resource (no owner/user)
async function handleAddIdentityCLI(options: AddIdentityOptions): Promise<void> {
  const validation = validateAddIdentityOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAddIdentity({
    name: options.name!,
    apiKey: options.apiKey!,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added credential '${result.credentialName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export function registerAdd(program: Command) {
  const addCmd = program
    .command('add')
    .description(COMMAND_DESCRIPTIONS.add)
    // Catch-all argument for invalid subcommands - Commander matches subcommands first
    .argument('[subcommand]')
    .action((subcommand: string | undefined, _options, cmd) => {
      if (subcommand) {
        console.error(`error: '${subcommand}' is not a valid subcommand.`);
        cmd.outputHelp();
        process.exit(1);
      }

      requireProject();

      const { clear, unmount } = render(
        <AddFlow
          isInteractive={false}
          onExit={() => {
            clear();
            unmount();
          }}
        />
      );
    })
    .showHelpAfterError()
    .showSuggestionAfterError();

  // Subcommand: add agent
  addCmd
    .command('agent')
    .description('Add an agent to the project')
    .option('--name <name>', 'Agent name (start with letter, alphanumeric only, max 64 chars) [non-interactive]')
    .option('--type <type>', 'Agent type: create or byo [non-interactive]', 'create')
    .option('--build <type>', 'Build type: CodeZip or Container (default: CodeZip) [non-interactive]')
    .option('--language <lang>', 'Language: Python (create), or Python/TypeScript/Other (BYO) [non-interactive]')
    .option(
      '--framework <fw>',
      'Framework: Strands, LangChain_LangGraph, CrewAI, GoogleADK, OpenAIAgents [non-interactive]'
    )
    .option('--model-provider <provider>', 'Model provider: Bedrock, Anthropic, OpenAI, Gemini [non-interactive]')
    .option('--api-key <key>', 'API key for non-Bedrock providers [non-interactive]')
    .option('--memory <mem>', 'Memory: none, shortTerm, longAndShortTerm (create path only) [non-interactive]')
    .option('--code-location <path>', 'Path to existing code (BYO path only) [non-interactive]')
    .option('--entrypoint <file>', 'Entry file relative to code-location (BYO, default: main.py) [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async options => {
      requireProject();
      await handleAddAgentCLI(options as AddAgentOptions);
    });

  // Subcommand: add gateway (disabled - coming soon)
  addCmd
    .command('gateway', { hidden: true })
    .description('Add an MCP gateway to the project')
    .option('--name <name>', 'Gateway name')
    .option('--description <desc>', 'Gateway description')
    .option('--authorizer-type <type>', 'Authorizer type: NONE or CUSTOM_JWT', 'NONE')
    .option('--discovery-url <url>', 'OIDC discovery URL (required for CUSTOM_JWT)')
    .option('--allowed-audience <values>', 'Comma-separated allowed audience values (required for CUSTOM_JWT)')
    .option('--allowed-clients <values>', 'Comma-separated allowed client IDs (required for CUSTOM_JWT)')
    .option('--agents <names>', 'Comma-separated agent names to attach gateway to')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('AgentCore Gateway integration is coming soon.');
      process.exit(1);
    });

  // Subcommand: add mcp-tool (disabled - coming soon)
  addCmd
    .command('mcp-tool', { hidden: true })
    .description('Add an MCP tool to the project')
    .option('--name <name>', 'Tool name')
    .option('--description <desc>', 'Tool description')
    .option('--language <lang>', 'Language: Python or TypeScript')
    .option('--exposure <mode>', 'Exposure mode: mcp-runtime or behind-gateway')
    .option('--agents <names>', 'Comma-separated agent names (for mcp-runtime)')
    .option('--gateway <name>', 'Gateway name (for behind-gateway)')
    .option('--host <host>', 'Compute host: Lambda or AgentCoreRuntime (for behind-gateway)')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('MCP Tool integration is coming soon.');
      process.exit(1);
    });

  // Subcommand: add memory (v2: top-level resource)
  addCmd
    .command('memory')
    .description('Add a memory resource to the project')
    .option('--name <name>', 'Memory name [non-interactive]')
    .option(
      '--strategies <types>',
      'Comma-separated strategies: SEMANTIC, SUMMARIZATION, USER_PREFERENCE [non-interactive]'
    )
    .option('--expiry <days>', 'Event expiry duration in days (default: 30) [non-interactive]', parseInt)
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async options => {
      requireProject();
      await handleAddMemoryCLI(options as AddMemoryOptions);
    });

  // Subcommand: add identity (v2: top-level credential resource)
  addCmd
    .command('identity')
    .description('Add a credential to the project')
    .option('--name <name>', 'Credential name [non-interactive]')
    .option('--api-key <key>', 'The API key value [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async options => {
      requireProject();
      await handleAddIdentityCLI(options as AddIdentityOptions);
    });
}
