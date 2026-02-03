// Mock for the CLI module that creates a Commander program
// This avoids importing the real cli.ts which has many Node.js dependencies

// Mock CommandMeta type
export interface MockCommand {
  name(): string;
  description(): string;
  commands: MockCommand[];
}

// Create a mock program with minimal commands for UI testing
export function createProgram(): MockCommand {
  const mockCommands: MockCommand[] = [
    { name: () => 'init', description: () => 'Initialize a new AgentCore workspace', commands: [] },
    { name: () => 'create', description: () => 'Create a new agent or tool', commands: [] },
    { name: () => 'dev', description: () => 'Start local development server', commands: [] },
    { name: () => 'deploy', description: () => 'Deploy to AWS', commands: [] },
    { name: () => 'edit', description: () => 'Edit workspace configuration', commands: [] },
    { name: () => 'add', description: () => 'Add MCP tools or gateways', commands: [] },
    { name: () => 'status', description: () => 'Show workspace status', commands: [] },
  ];

  return {
    name: () => 'agentcore',
    description: () => 'AgentCore CLI',
    version: () => '0.0.0-browser',
    commands: mockCommands,
  } as MockCommand & { version: () => string };
}
