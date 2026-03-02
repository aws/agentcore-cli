import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { AddFlow } from '../../tui/screens/add/AddFlow';
import {
  handleAddAgent,
  handleAddGateway,
  handleAddGatewayTarget,
  handleAddIdentity,
  handleAddMemory,
} from './actions';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddGatewayTargetOptions,
  AddIdentityOptions,
  AddMemoryOptions,
} from './types';
import {
  validateAddAgentOptions,
  validateAddGatewayOptions,
  validateAddGatewayTargetOptions,
  validateAddIdentityOptions,
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

async function handleAddGatewayCLI(options: AddGatewayOptions): Promise<void> {
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
    allowedScopes: options.allowedScopes,
    agentClientId: options.agentClientId,
    agentClientSecret: options.agentClientSecret,
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

async function handleAddGatewayTargetCLI(options: AddGatewayTargetOptions): Promise<void> {
  const validation = await validateAddGatewayTargetOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  // Map CLI flag values to internal types
  const outboundAuthMap: Record<string, 'OAUTH' | 'API_KEY' | 'NONE'> = {
    oauth: 'OAUTH',
    'api-key': 'API_KEY',
    none: 'NONE',
  };

  const result = await handleAddGatewayTarget({
    name: options.name!,
    description: options.description,
    language: options.language! as 'Python' | 'TypeScript',
    gateway: options.gateway,
    host: options.host,
    outboundAuthType: options.outboundAuthType ? outboundAuthMap[options.outboundAuthType.toLowerCase()] : undefined,
    credentialName: options.credentialName,
    oauthClientId: options.oauthClientId,
    oauthClientSecret: options.oauthClientSecret,
    oauthDiscoveryUrl: options.oauthDiscoveryUrl,
    oauthScopes: options.oauthScopes,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added gateway target '${result.toolName}'`);
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

  const identityType = options.type ?? 'api-key';
  const result =
    identityType === 'oauth'
      ? await handleAddIdentity({
          type: 'oauth',
          name: options.name!,
          discoveryUrl: options.discoveryUrl!,
          clientId: options.clientId!,
          clientSecret: options.clientSecret!,
          scopes: options.scopes,
        })
      : await handleAddIdentity({
          type: 'api-key',
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

  // Subcommand: add gateway
  addCmd
    .command('gateway')
    .description('Add a gateway to the project')
    .option('--name <name>', 'Gateway name')
    .option('--description <desc>', 'Gateway description')
    .option('--authorizer-type <type>', 'Authorizer type: NONE or CUSTOM_JWT', 'NONE')
    .option('--discovery-url <url>', 'OIDC discovery URL (required for CUSTOM_JWT)')
    .option('--allowed-audience <values>', 'Comma-separated allowed audience values (required for CUSTOM_JWT)')
    .option('--allowed-clients <values>', 'Comma-separated allowed client IDs (required for CUSTOM_JWT)')
    .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (optional for CUSTOM_JWT)')
    .option('--agent-client-id <id>', 'Agent OAuth client ID for Bearer token auth (CUSTOM_JWT)')
    .option('--agent-client-secret <secret>', 'Agent OAuth client secret (CUSTOM_JWT)')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAddGatewayCLI(options as AddGatewayOptions);
    });

  // Subcommand: add gateway-target
  addCmd
    .command('gateway-target')
    .description('Add a gateway target to the project')
    .option('--name <name>', 'Tool name')
    .option('--description <desc>', 'Tool description')
    .option('--type <type>', 'Target type: mcpServer or lambda')
    .option('--source <source>', 'Source: existing-endpoint or create-new')
    .option('--endpoint <url>', 'MCP server endpoint URL')
    .option('--language <lang>', 'Language: Python or TypeScript')
    .option('--gateway <name>', 'Gateway name')
    .option('--host <host>', 'Compute host: Lambda or AgentCoreRuntime')
    .option('--outbound-auth <type>', 'Outbound auth type: oauth, api-key, or none')
    .option('--credential-name <name>', 'Existing credential name for outbound auth')
    .option('--oauth-client-id <id>', 'OAuth client ID (creates credential inline)')
    .option('--oauth-client-secret <secret>', 'OAuth client secret (creates credential inline)')
    .option('--oauth-discovery-url <url>', 'OAuth discovery URL (creates credential inline)')
    .option('--oauth-scopes <scopes>', 'OAuth scopes, comma-separated')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAddGatewayTargetCLI(options as AddGatewayTargetOptions);
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
    .option('--type <type>', 'Credential type: api-key (default) or oauth')
    .option('--api-key <key>', 'The API key value [non-interactive]')
    .option('--discovery-url <url>', 'OAuth discovery URL')
    .option('--client-id <id>', 'OAuth client ID')
    .option('--client-secret <secret>', 'OAuth client secret')
    .option('--scopes <scopes>', 'OAuth scopes, comma-separated')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async options => {
      requireProject();
      await handleAddIdentityCLI(options as AddIdentityOptions);
    });
}
