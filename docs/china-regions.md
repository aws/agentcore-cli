# China (aws-cn) regions

`cn-north-1` and `cn-northwest-1` are supported, with three differences:

- **Templates:** Amazon Bedrock, Anthropic, OpenAI, and Gemini are not accessible from China
  regions, so templates wired to those providers (and `--type import`, which reads from Amazon
  Bedrock) are rejected when a deployment target is in a China region. Bring your own agent
  implementation instead: scaffold with `agent-python-minimal` or `mcp-python-fastmcp` and add
  your own model connectivity, or use `--template agent-python-strands --model-provider litellm
--model-id <model>` with a [LiteLLM model](https://docs.litellm.ai/docs/providers) reachable
  from China — no default model id is applied there, and the `bedrock/` LiteLLM prefix (which
  routes to Amazon Bedrock) is rejected. The scaffolded runtime records `modelProvider` and,
  for LiteLLM, `modelId` in `agentcore.json` so deploys can re-check this.
- The restrictions are enforced wherever the region is known: at `agentcore create` when the
  resolved region (`--region`, environment, or profile) is a China region, at
  `agentcore add runtime` once deployment targets exist, and at `agentcore deploy` — deploying
  to a China target fails when a runtime was scaffolded with an inaccessible model provider
  (recorded as the runtime's `modelProvider` in `agentcore.json`; delete that field if you have
  replaced the model wiring in code). Harness projects are not available in China regions.
- **Resource families:** only Runtimes, Gateways, and credentials are available in China
  regions. The strands template's default memory is dropped from China scaffolds (the memory
  module stays in the code and activates once a memory exists); adding unsupported resources
  (memory, evaluators, harnesses, payments, …) or deploying a spec that contains them to a
  China target fails with an explicit message.
- **Telemetry** is always disabled when the ambient AWS region or any deployment target is a
  China region.
