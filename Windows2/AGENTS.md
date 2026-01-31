# AgentCore Project

This project contains configuration and infrastructure for an Amazon Bedrock AgentCore application.

The `agentcore/` directory serves as a declarative model of an AgentCore project along with a concrete implementation
through the `agentcore/cdk/` project which is modeled to take the configs as input. The project models Agents and MCP
setups with their own overloaded constructs. Agents are first-class.

## Mental Model

A good mental model for how this project works is a directed graph. We have a set of nodes: agents, memories,
identities, gateways, tools, mcp servers, and future resources supported. There are rules about which nodes can connect
to others in what direction.

For example, stand-alone memory or identity resources cannot be modeled--they need to be owned by an agent and can be
used by other agents.

Wiring nodes creates an infrastructure and trust relationship but is not enough to complete end-to-end functionality.
For example, attaching agentB as a remote tool for agentA means that agentA has permission to invoke agentB and that
agentA has the ARN for agentB as an environment variable with the name specified in the agentcore.json schema.

To complete a functional connection, the application code in agentA needs to construct the appropriate call to
`invoke_agent_runtime` which will succeed based on the wiring declared in the schema and implemented in the `cdk/`
directory.

## Critical Invariants

1. **Schema-First Authority:** The `.json` files are the absolute source of truth. Do not attempt to modify agent
   behavior by editing the generated CDK code in `cdk/`.
2. **Resource Identity:** The `name` field in the schema determines the CloudFormation Logical ID.
   - **Renaming** an agent, gateway, or target will **destroy and recreate** that resource.
   - **Modifying** other fields (descriptions, prompts, runtime config) will update the resource **in-place**.
3. **1:1 Validation:** The schema maps directly to valid CloudFormation. If your JSON conforms to the types in
   `.llm-context/`, it will deploy successfully.

## Directory Structure

```
myNewProject/
├── AGENTS.md               # This file - AI coding assistant context
├── agentcore/              # AgentCore configuration directory
│   ├── agentcore.json      # Main workspace config (AgentCoreWorkspaceSpec)
│   ├── mcp.json            # MCP gateways and tools (AgentCoreMcpSpec)
│   ├── mcp-defs.json       # Tool definitions (AgentCoreCliMcpDefs)
│   ├── .llm-context/       # TypeScript type definitions for AI coding assistants
│   │   ├── README.md       # Guide to using the schema files
│   │   ├── agentcore.ts    # AgentCoreWorkspaceSpec types
│   │   ├── agent-env.ts    # AgentEnvSpec and runtime types
│   │   ├── mcp.ts          # MCP gateway and tool types
│   │   └── aws-targets.ts  # AWS deployment target types
│   └── cdk/                # AWS CDK project for deployment
└── ... (your application code)
```

## Schema Reference

The `agentcore/.llm-context/` directory contains TypeScript type definitions optimized for AI coding assistants. Each
file maps to a JSON config file and includes validation constraints as comments.

| JSON Config                | Schema File                             | Root Type                |
| -------------------------- | --------------------------------------- | ------------------------ |
| `agentcore/agentcore.json` | `agentcore/.llm-context/agentcore.ts`   | `AgentCoreWorkspaceSpec` |
| `agentcore/mcp.json`       | `agentcore/.llm-context/mcp.ts`         | `AgentCoreMcpSpec`       |
| `agentcore/mcp-defs.json`  | `agentcore/.llm-context/mcp.ts`         | `AgentCoreCliMcpDefs`    |
| (aws-targets)              | `agentcore/.llm-context/aws-targets.ts` | `AWSDeploymentTarget[]`  |

### Key Types

- **AgentEnvSpec**: Agent configuration (runtime, memory, identity, tools)
- **Runtime**: Discriminated union of `CodeZipRuntime` | `ContainerImageRuntime`
- **MemoryProvider**: `OwnedMemoryProvider` (creates memory) | `ReferencedMemoryProvider` (uses existing)
- **AgentCoreGateway**: MCP gateway with tool targets
- **ToolDefinition**: Tool name, description, input/output schemas

### Common Enum Values

- **ArtifactType**: `'CodeZip'` | `'ContainerImage'`
- **NetworkMode**: `'PUBLIC'` | `'PRIVATE'`
- **Relation**: `'own'` | `'use'` (for memory providers)
- **ModelProvider**: `'Bedrock'` | `'Anthropic'` | `'OpenAI'` | `'Gemini'`
- **ComputeHost**: `'Lambda'` | `'AgentCoreRuntime'`

### Specific Context

Directory pathing to local projects is required for runtimes and tools backed by a modeled compute. Only Python offers a
zip based direct code deploy option. All other programming languages are required to be containerized and provide a path
do a `Dockerfile` definition.

MCP tools offer Lambda compute and AgentCore runtime compute. If something like a `FastMCP` server is desired, AgentCore
runtime is a better fit. When using Lambda, the input schema needs to be modeled in `mcp-defs.json` and the lambda
handler needs to be a traditional (context, event) style input shape.

## Deployment

The `agentcore/cdk/` subdirectory contains an AWS CDK node project.

Deployments of this project are primarily intended to be orchestrated through the `agentcore deploy` command in the CLI.

Alternatively, the project can be deployed directly as a traditional CDK project:

```bash
cd agentcore/cdk
npm install
npx cdk synth   # Preview CloudFormation template
npx cdk deploy  # Deploy to AWS
```

Both CLI and direct deployment have the same source of truth and are safe to be substituted interchangeably.

## Editing Schemas

When modifying JSON config files:

1. Read the corresponding `agentcore/.llm-context/*.ts` file for type definitions
2. Check validation constraint comments (`@regex`, `@min`, `@max`)
3. Use exact enum values as string literals
4. Use CloudFormation-safe names (alphanumeric, start with letter)
5. Run `agentcore validate` command to verify changes.
