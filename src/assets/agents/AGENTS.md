# AgentCore Project

This project contains configuration and infrastructure for an Amazon Bedrock AgentCore application.

The `agentcore/` directory serves as a declarative model of an AgentCore project along with a concrete implementation
through the `agentcore/cdk/` project which is modeled to take the configs as input. The project uses a **flat resource
model** where agents, memories, and credentials are top-level arrays.

## Mental Model

A good mental model for how this project works is a directed graph. We have a set of nodes: agents, memories,
credentials, and future resources supported. There are rules about which nodes can connect to others in what direction.

Wiring nodes creates an infrastructure and trust relationship but is not enough to complete end-to-end functionality.
For example, to use a memory from an agent, the application code needs to read the memory ID from an environment
variable and construct the appropriate SDK calls.

## Critical Invariants

1. **Schema-First Authority:** The `.json` files are the absolute source of truth. Do not attempt to modify agent
   behavior by editing the generated CDK code in `cdk/`.
2. **Resource Identity:** The `name` field in the schema determines the CloudFormation Logical ID.
   - **Renaming** an agent or target will **destroy and recreate** that resource.
   - **Modifying** other fields (descriptions, config) will update the resource **in-place**.
3. **1:1 Validation:** The schema maps directly to valid CloudFormation. If your JSON conforms to the types in
   `.llm-context/`, it will deploy successfully.

## Directory Structure

```
myNewProject/
├── AGENTS.md               # This file - AI coding assistant context
├── agentcore/              # AgentCore configuration directory
│   ├── agentcore.json      # Main project config (AgentCoreProjectSpec)
│   ├── aws-targets.json    # Deployment targets
│   ├── .llm-context/       # TypeScript type definitions for AI coding assistants
│   │   ├── README.md       # Guide to using the schema files
│   │   ├── agentcore.ts    # AgentCoreProjectSpec types
│   │   └── aws-targets.ts  # AWS deployment target types
│   └── cdk/                # AWS CDK project for deployment
└── app/                    # Application code (if agents were created)
```

## Schema Reference

The `agentcore/.llm-context/` directory contains TypeScript type definitions optimized for AI coding assistants. Each
file maps to a JSON config file and includes validation constraints as comments.

| JSON Config                  | Schema File                             | Root Type               |
| ---------------------------- | --------------------------------------- | ----------------------- |
| `agentcore/agentcore.json`   | `agentcore/.llm-context/agentcore.ts`   | `AgentCoreProjectSpec`  |
| `agentcore/aws-targets.json` | `agentcore/.llm-context/aws-targets.ts` | `AWSDeploymentTarget[]` |

### Key Types

- **AgentCoreProjectSpec**: Root project configuration with `agents`, `memories`, `credentials` arrays
- **AgentEnvSpec**: Agent configuration (runtime, entrypoint, code location)
- **Memory**: Memory resource with strategies and expiry
- **Credential**: API key credential provider

### Common Enum Values

- **BuildType**: `'CodeZip'` | `'Container'`
- **NetworkMode**: `'PUBLIC'` | `'PRIVATE'`
- **RuntimeVersion**: `'PYTHON_3_12'` | `'PYTHON_3_13'` | `'NODE_18'` | `'NODE_20'` | `'NODE_22'`
- **MemoryStrategyType**: `'SEMANTIC'` | `'SUMMARIZATION'` | `'USER_PREFERENCE'`

### Supported Frameworks (for template agents)

- **Strands** - Works with Bedrock, Anthropic, OpenAI, Gemini
- **LangChain_LangGraph** - Works with Bedrock, Anthropic, OpenAI, Gemini
- **GoogleADK** - Gemini only
- **OpenAIAgents** - OpenAI only

### Specific Context

Directory pathing to local projects is required for runtimes. Only Python offers a zip based direct code deploy option.
All other programming languages are required to be containerized and provide a path to a `Dockerfile` definition.

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
