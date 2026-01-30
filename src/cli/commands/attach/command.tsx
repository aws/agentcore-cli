import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { AttachFlow } from '../../tui/screens/attach/AttachFlow';
import {
  handleAttachAgent,
  handleAttachGateway,
  handleAttachIdentity,
  handleAttachMcpRuntime,
  handleAttachMemory,
} from './actions';
import type {
  AttachAgentOptions,
  AttachGatewayOptions,
  AttachIdentityOptions,
  AttachMcpRuntimeOptions,
  AttachMemoryOptions,
} from './types';
import {
  validateAttachAgentOptions,
  validateAttachGatewayOptions,
  validateAttachIdentityOptions,
  validateAttachMcpRuntimeOptions,
  validateAttachMemoryOptions,
} from './validate';
import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

async function handleAttachAgentCLI(options: AttachAgentOptions): Promise<void> {
  const validation = validateAttachAgentOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAttachAgent({
    source: options.source!,
    target: options.target!,
    name: options.name,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Attached agent '${result.targetAgent}' to '${result.sourceAgent}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

async function handleAttachMemoryCLI(options: AttachMemoryOptions): Promise<void> {
  const validation = validateAttachMemoryOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAttachMemory({
    agent: options.agent!,
    memory: options.memory!,
    access: options.access,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Attached memory '${result.memoryName}' to '${result.agentName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

async function handleAttachIdentityCLI(options: AttachIdentityOptions): Promise<void> {
  const validation = validateAttachIdentityOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAttachIdentity({
    agent: options.agent!,
    identity: options.identity!,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Attached identity '${result.identityName}' to '${result.agentName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

async function handleAttachMcpRuntimeCLI(options: AttachMcpRuntimeOptions): Promise<void> {
  const validation = validateAttachMcpRuntimeOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAttachMcpRuntime({
    agent: options.agent!,
    runtime: options.runtime!,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Bound agent '${result.agentName}' to MCP runtime '${result.runtimeName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

async function handleAttachGatewayCLI(options: AttachGatewayOptions): Promise<void> {
  const validation = validateAttachGatewayOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleAttachGateway({
    agent: options.agent!,
    gateway: options.gateway!,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Attached gateway '${result.gatewayName}' to '${result.agentName}'`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export function registerAttach(program: Command) {
  const attachCmd = program
    .command('attach')
    .description(COMMAND_DESCRIPTIONS.attach)
    .action(() => {
      requireProject();

      const { clear, unmount } = render(
        <AttachFlow
          onExit={() => {
            clear();
            unmount();
          }}
        />
      );
    });

  // Subcommand: attach agent
  attachCmd
    .command('agent')
    .description('Attach an agent to another agent for invocation')
    .option('--source <agent>', 'Source agent (the one that will invoke)')
    .option('--target <agent>', 'Target agent (the one to be invoked)')
    .option('--name <name>', 'Optional name for the remote tool reference')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAttachAgentCLI(options as AttachAgentOptions);
    });

  // Subcommand: attach memory
  attachCmd
    .command('memory')
    .description('Attach a memory to an agent')
    .option('--agent <agent>', 'Agent to attach memory to')
    .option('--memory <memory>', 'Memory name to attach')
    .option('--access <level>', 'Access level: read or readwrite (default: readwrite)')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAttachMemoryCLI(options as AttachMemoryOptions);
    });

  // Subcommand: attach identity
  attachCmd
    .command('identity')
    .description('Attach an identity to an agent')
    .option('--agent <agent>', 'Agent to attach identity to')
    .option('--identity <identity>', 'Identity name to attach')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAttachIdentityCLI(options as AttachIdentityOptions);
    });

  // Subcommand: attach mcp-runtime
  attachCmd
    .command('mcp-runtime')
    .description('Bind an agent to an MCP runtime tool')
    .option('--agent <agent>', 'Agent to bind')
    .option('--runtime <runtime>', 'MCP runtime name to bind to')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAttachMcpRuntimeCLI(options as AttachMcpRuntimeOptions);
    });

  // Subcommand: attach gateway
  attachCmd
    .command('gateway')
    .description('Attach an MCP gateway to an agent')
    .option('--agent <agent>', 'Agent to attach gateway to')
    .option('--gateway <gateway>', 'Gateway name to attach')
    .option('--json', 'Output as JSON')
    .action(async options => {
      requireProject();
      await handleAttachGatewayCLI(options as AttachGatewayOptions);
    });
}
