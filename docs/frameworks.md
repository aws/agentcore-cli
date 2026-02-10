# Agent Frameworks

AgentCore CLI supports multiple agent frameworks for template-based agent creation, plus a BYO (Bring Your Own) option
for existing code.

## Available Frameworks

| Framework               | Supported Model Providers          |
| ----------------------- | ---------------------------------- |
| **Strands**             | Bedrock, Anthropic, OpenAI, Gemini |
| **LangChain_LangGraph** | Bedrock, Anthropic, OpenAI, Gemini |
| **GoogleADK**           | Gemini only                        |
| **OpenAIAgents**        | OpenAI only                        |

## Framework Selection Guide

### Strands

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
3. **Language**: Python, TypeScript, or Other (requires container build)

### BYO Options

| Flag                     | Description                                |
| ------------------------ | ------------------------------------------ |
| `--type byo`             | Use BYO mode (required)                    |
| `--code-location <path>` | Directory containing your agent code       |
| `--entrypoint <file>`    | Entry file (e.g., `main.py` or `index.ts`) |
| `--language <lang>`      | `Python`, `TypeScript`, or `Other`         |

## Framework Comparison

| Feature                | Strands | LangChain | GoogleADK | OpenAIAgents |
| ---------------------- | ------- | --------- | --------- | ------------ |
| Multi-provider support | Yes     | Yes       | No        | No           |
| AWS Bedrock native     | Yes     | No        | No        | No           |
| Tool ecosystem         | Growing | Extensive | Moderate  | Moderate     |
| Memory integration     | Native  | Via libs  | Via libs  | Via libs     |

## Changing Frameworks

To switch frameworks for an existing project, you'll need to:

1. Create a new agent with the desired framework:

   ```bash
   agentcore add agent --name NewAgent --framework LangChain_LangGraph
   ```

2. Migrate your agent logic to the new framework's structure

3. Remove the old agent (optional):
   ```bash
   agentcore remove agent --name OldAgent
   ```

Agent framework and model provider are only used during template generation. The generated code can be modified to use
any compatible SDK or model.
