# Agent Frameworks

AgentCore CLI supports multiple agent frameworks for template-based agent creation, plus a BYO (Bring Your Own) option
for existing code.

## Available Frameworks

| Framework               | Supported Model Providers          |
| ----------------------- | ---------------------------------- |
| **Strands Agents**      | Bedrock, Anthropic, OpenAI, Gemini |
| **LangChain_LangGraph** | Bedrock, Anthropic, OpenAI, Gemini |
| **GoogleADK**           | Gemini only                        |
| **OpenAIAgents**        | OpenAI only                        |

## Framework Selection Guide

### Strands Agents

AWS's native agent framework designed for Amazon Bedrock.

**Best for:**

- Projects primarily using Amazon Bedrock models
- Integration with AWS services
- Production deployments on AWS infrastructure

**Model providers:** Bedrock, Anthropic, OpenAI, Gemini

```bash
agentcore create --framework Strands --model-provider Bedrock
```

### LangChain / LangGraph

Popular open-source framework with extensive ecosystem.

**Best for:**

- Complex multi-step agent workflows
- Projects requiring LangChain's extensive tool ecosystem
- Teams already familiar with LangChain

**Model providers:** Bedrock, Anthropic, OpenAI, Gemini

```bash
agentcore create --framework LangChain_LangGraph --model-provider Anthropic
```

### GoogleADK

Google's Agent Development Kit.

**Best for:**

- Projects using Google's Gemini models
- Integration with Google Cloud services

**Model providers:** Gemini only

```bash
agentcore create --framework GoogleADK --model-provider Gemini
```

### OpenAIAgents

OpenAI's native agent framework.

**Best for:**

- Projects using OpenAI models exclusively
- Simple agent workflows with OpenAI's function calling

**Model providers:** OpenAI only

```bash
agentcore create --framework OpenAIAgents --model-provider OpenAI --api-key sk-...
```

## Import from Bedrock Agents

If you have an existing Bedrock Agent, you can import its configuration and translate it into runnable Strands or
LangChain/LangGraph code. The imported agent preserves your Bedrock Agent's action groups, knowledge bases, multi-agent
collaboration, guardrails, prompts, and memory configuration.

```bash
# Interactive (select "Import from Bedrock Agents" in the wizard)
agentcore add agent

# Non-interactive
agentcore add agent \
  --name MyAgent \
  --type import \
  --agent-id AGENT123 \
  --agent-alias-id ALIAS456 \
  --region us-east-1 \
  --framework Strands \
  --memory none
```

### What gets imported

The import process fetches your Bedrock Agent's full configuration and translates it into framework-specific Python code
that runs on AgentCore:

- **Action groups** (function-schema and built-in) become `@tool` decorated functions
- **Knowledge bases** become retrieval tool integrations
- **Multi-agent collaboration** produces separate collaborator files with recursive translation
- **Code interpreter** wires to AgentCore's `code_interpreter_client`
- **Guardrails** are configured in the model initialization
- **Prompt overrides** are preserved as template variables
- **Memory** integrates with AgentCore's memory service when enabled

### Import options

| Flag                    | Description                               |
| ----------------------- | ----------------------------------------- |
| `--type import`         | Use import mode (required)                |
| `--agent-id <id>`       | Bedrock Agent ID                          |
| `--agent-alias-id <id>` | Bedrock Agent Alias ID                    |
| `--region <region>`     | AWS region where the Bedrock Agent exists |
| `--framework <fw>`      | `Strands` or `LangChain_LangGraph`        |
| `--memory <opt>`        | `none`, `shortTerm`, `longAndShortTerm`   |

## Bring Your Own (BYO) Agent

For existing agent code or frameworks not listed above, use the BYO option:

```bash
agentcore add agent \
  --name MyAgent \
  --type byo \
  --code-location ./my-agent \
  --entrypoint main.py \
  --language Python
```

### BYO Requirements

1. **Entrypoint**: Your code must expose an HTTP endpoint that accepts agent invocation requests
2. **Code location**: Directory containing your agent code
3. **Language**: Python

### BYO Options

| Flag                     | Description                                |
| ------------------------ | ------------------------------------------ |
| `--type byo`             | Use BYO mode (required)                    |
| `--code-location <path>` | Directory containing your agent code       |
| `--entrypoint <file>`    | Entry file (e.g., `main.py` or `index.ts`) |
| `--language <lang>`      | `Python`                                   |

## Framework Comparison

| Feature                | Strands | LangChain | GoogleADK | OpenAIAgents |
| ---------------------- | ------- | --------- | --------- | ------------ |
| Multi-provider support | Yes     | Yes       | No        | No           |
| AWS Bedrock native     | Yes     | No        | No        | No           |
| Tool ecosystem         | Growing | Extensive | Moderate  | Moderate     |
| Memory integration     | Native  | Via libs  | Via libs  | Via libs     |

## Protocol Compatibility

Not all frameworks support all protocol modes. MCP protocol is a standalone tool server with no framework.

| Protocol | Supported Frameworks                                          |
| -------- | ------------------------------------------------------------- |
| **HTTP** | Strands, LangChain_LangGraph, GoogleADK, OpenAIAgents |
| **MCP**  | None (standalone tool server)                                 |
| **A2A**  | Strands, GoogleADK, LangChain_LangGraph                       |
