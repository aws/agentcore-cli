import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { AddFlow } from '../../tui/screens/add/AddFlow';
import {
  handleAddAgent,
  handleAddGateway,
  handleAddIdentity,
  handleAddMcpTool,
  handleAddMemory,
  handleBindMcpRuntime,
} from './actions';
import { handleAddTarget } from './target-action';
import type {
  AddAgentOptions,
  AddGatewayOptions,
  AddIdentityOptions,
  AddMcpToolOptions,
  AddMemoryOptions,
  BindMcpRuntimeOptions,
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

interface AddTargetCliOptions {
  name?: string;
  account?: string;
  region?: string;
  description?: string;
  json?: boolean;
}

async function handleAddTargetCLI(options: AddTargetCliOptions): Promise<void> {
  if (!options.name || !options.account || !options.region) {
    const error = 'Required: --name, --account, --region';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const result = await handleAddTarget({
    name: options.name,
    account: options.account,
    region: options.region,
    description: options.description,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Added target '${options.name}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

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
    strategies: options.strategies!,
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

// MCP Runtime binding (still relevant in v2)
async function handleBindMcpRuntimeCLI(options: BindMcpRuntimeOptions): Promise<void> {
  if (!options.agent || !options.runtime) {
    const error = 'Required: --agent, --runtime';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const envVar = options.envVar ?? `${options.runtime.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_RUNTIME_URL`;
  const result = await handleBindMcpRuntime({
    agent: options.agent,
    runtime: options.runtime,
    envVar,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Bound MCP runtime '${result.runtimeName}' to agent '${result.targetAgent}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// Bind CLI handlers
async function handleBindMemoryCLI(options: BindMemoryOptions): Promise<void> {
  if (!options.agent || !options.memory) {
    const error = 'Required: --agent, --memory';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const envVar = options.envVar ?? `${options.memory.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MEMORY_ID`;
  const result = await handleBindMemory({
    agent: options.agent,
    memory: options.memory,
    access: options.access! ?? 'read',
    envVar,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Bound memory '${result.memoryName}' to agent '${result.targetAgent}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

async function handleBindIdentityCLI(options: BindIdentityOptions): Promise<void> {
  if (!options.agent || !options.identity) {
    const error = 'Required: --agent, --identity';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const envVar = options.envVar ?? `${options.identity.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CREDENTIAL_ID`;
  const result = await handleBindIdentity({
    agent: options.agent,
    identity: options.identity,
    envVar,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Bound identity '${result.identityName}' to agent '${result.targetAgent}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

// Gateway disabled - prefix with underscore until feature is re-enabled
async function _handleBindGatewayCLI(options: BindGatewayOptions): Promise<void> {
  if (!options.agent || !options.gateway) {
    const error = 'Required: --agent, --gateway';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const name = options.name ?? `${options.gateway}-provider`;
  const description = options.description ?? `Tools provided by ${options.gateway} gateway`;
  const envVar = options.envVar ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;

  const result = await handleBindGateway({
    agent: options.agent,
    gateway: options.gateway,
    name,
    description,
    envVar,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Bound gateway '${result.gatewayName}' to agent '${result.targetAgent}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}


async function handleBindAgentCLI(options: BindAgentOptions): Promise<void> {
  if (!options.source || !options.target) {
    const error = 'Required: --source, --target';
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const name = options.name ?? `invoke${options.target.replace(/[^a-zA-Z0-9]/g, '')}`;
  const description = options.description ?? `Invoke the ${options.target} agent`;
  const envVar = options.envVar ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AGENT_ID`;

  const result = await handleBindAgent({
    source: options.source,
    target: options.target,
    name,
    description,
    envVar,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(
      `Bound agent '${result.targetAgent}' as remote tool '${result.toolName}' to agent '${result.sourceAgent}'`
    );
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export function registerAdd(program: Command) {
  const addCmd = program
    .command('add')
    .description(COMMAND_DESCRIPTIONS.add)
    .action(() => {
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
    });

  // Subcommand: add target
  addCmd
    .command('target')
    .description('Add a deployment target')
    .option('--name <name>', 'Target name')
    .option('--account <id>', 'AWS account ID')
    .option('--region <region>', 'AWS region')
    .option('--description <desc>', 'Optional description')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAddTargetCLI(options);
    });

  // Subcommand: add agent
  addCmd
    .command('agent')
    .description('Add an agent to the project')
    .option('--name <name>', 'Agent name (start with letter, alphanumeric only, max 64 chars)')
    .option('--type <type>', 'Agent type: create or byo', 'create')
    .option('--language <lang>', 'Language: Python (create), or Python/TypeScript/Other (BYO)')
    .option('--framework <fw>', 'Framework: Strands, LangChain_LangGraph, AutoGen, CrewAI, GoogleADK, OpenAIAgents')
    .option('--model-provider <provider>', 'Model provider: Bedrock, Anthropic, OpenAI, Gemini')
    .option('--api-key <key>', 'API key for non-Bedrock providers')
    .option('--memory <mem>', 'Memory: none, shortTerm, longAndShortTerm (create path only)')
    .option('--code-location <path>', 'Path to existing code (BYO path only)')
    .option('--entrypoint <file>', 'Entry file relative to code-location (BYO, default: main.py)')
    .option('--json', 'Output as JSON')
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
    .option('--name <name>', 'Memory name')
    .option(
      '--strategies <types>',
      'Comma-separated strategies: SEMANTIC, SUMMARIZATION, USER_PREFERENCE, EPISODIC, CUSTOM'
    )
    .option('--expiry <days>', 'Event expiry duration in days (default: 30)', parseInt)
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      if (options.bind) {
        await handleBindMemoryCLI(options as BindMemoryOptions);
      } else {
        await handleAddMemoryCLI(options as AddMemoryOptions);
      }
    });

  // Subcommand: add identity (v2: top-level credential resource)
  addCmd
    .command('identity')
    .description('Add a credential to the project')
    .option('--name <name>', 'Credential name')
    .option('--api-key <key>', 'The API key value')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleBindAgentCLI(options as BindAgentOptions);
    });

  // Subcommand: add bind (explicit bind commands)
  const bindCmd = addCmd.command('bind').description('Bind existing resources to agents');

  // bind memory
  bindCmd
    .command('memory')
    .description('Bind existing memory to an agent')
    .requiredOption('--agent <name>', 'Target agent')
    .requiredOption('--memory <name>', 'Memory name to bind')
    .option('--access <level>', 'Access level: read or readwrite', 'read')
    .option('--env-var <name>', 'Environment variable name')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleBindMemoryCLI(options as BindMemoryOptions);
    });

  // bind identity
  bindCmd
    .command('identity')
    .description('Bind existing identity to an agent')
    .requiredOption('--agent <name>', 'Target agent')
    .requiredOption('--identity <name>', 'Identity name to bind')
    .option('--env-var <name>', 'Environment variable name')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleBindIdentityCLI(options as BindIdentityOptions);
    });

  // bind gateway (disabled - coming soon)
  bindCmd
    .command('gateway', { hidden: true })
    .description('Bind existing gateway to an agent')
    .requiredOption('--agent <name>', 'Target agent')
    .requiredOption('--gateway <name>', 'Gateway name to bind')
    .option('--name <name>', 'MCP provider name')
    .option('--description <desc>', 'Description')
    .option('--env-var <name>', 'Environment variable name')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('AgentCore Gateway integration is coming soon.');
      process.exit(1);
    });

  // bind mcp-runtime (disabled - coming soon)
  bindCmd
    .command('mcp-runtime', { hidden: true })
    .description('Bind existing MCP runtime to an agent')
    .requiredOption('--agent <name>', 'Target agent')
    .requiredOption('--runtime <name>', 'MCP runtime name to bind')
    .option('--env-var <name>', 'Environment variable name')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('MCP Tool integration is coming soon.');
      process.exit(1);
    });
}
