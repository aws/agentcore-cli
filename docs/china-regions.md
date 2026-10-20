# China (aws-cn) regions

`cn-north-1` and `cn-northwest-1` are supported, with three differences:

- **Templates:** Amazon Bedrock, Anthropic, OpenAI, and Gemini are not accessible from China
  regions, so templates wired to those providers (and `agentcore add runtime --agent-id`, which
  imports from Amazon Bedrock) are rejected when a deployment target is in a China region. Bring your own agent
  implementation instead: scaffold with `agent-python-minimal` or `mcp-python-fastmcp` and add
  your own model connectivity (or add a runtime for your own code with `agentcore add runtime`),
  or pick one of the two routes to a model that is reachable from China in the
  `agentcore create` wizard (`agentcore create --template` always scaffolds the template's
  Bedrock default): LiteLLM with a model id on a Python strands template
  (`agent-python-strands`, `agent-python-strands-container`, `a2a-python-strands`,
  `agui-python-strands`) with a
  [LiteLLM model](https://docs.litellm.ai/docs/providers) — no default model id is applied
  there, and the `bedrock/` LiteLLM prefix (which routes to Amazon Bedrock) is rejected — or
  an OpenAI-compatible endpoint with a base URL and model id on any strands template
  including `agent-typescript-strands`, pointing the OpenAI client at an OpenAI-compatible
  endpoint such as `https://api.deepseek.com/v1` (`open_ai` itself is rejected there like the
  other providers, since it calls api.openai.com). The scaffolded runtime records `modelProvider`
  and, for LiteLLM, `modelId` in `agentcore.json` so deploys can re-check this. In a China
  region the `agentcore create` wizard's model step starts on LiteLLM (Python) or openai-compatible
  (TypeScript), with no model id prefilled, marks the other providers as not accessible, and
  applies the same restrictions when the form is submitted.
- The restrictions are enforced wherever the region is known: at `agentcore create` when the
  resolved region (`--region`, environment, or profile) is a China region, at `agentcore add`
  when the project has a China deployment target — or, before the first deploy, when it has no
  target yet and the resolved region is a China region — and at `agentcore deploy` — deploying
  to a China target fails when a runtime was scaffolded with an inaccessible model provider
  (recorded as the runtime's `modelProvider` in `agentcore.json`; delete that field if you have
  replaced the model wiring in code). A runtime added with `agentcore add runtime` has no
  recorded `modelProvider`, so deploys only note that its model connectivity cannot be verified;
  make sure your code calls a model reachable from China. Harness projects are not available in
  China regions.
- **Resource families:** only Runtimes, Gateways (without connector-backed Targets: the curated
  `web-search` and `bedrock-knowledge-bases` connectors are refused there), and credentials are
  available in China
  regions. The strands template's default memory is dropped from China scaffolds (the memory
  module stays in the code and activates once a memory exists); adding unsupported resources
  (memory, evaluators, harnesses, payments, …) or deploying a spec that contains them to a
  China target fails with an explicit message. Those `add` subcommands say "not available in
  China regions" in their help, and the `agentcore add` menu warns when the project has a China
  deployment target.
- **Telemetry** is always disabled when the ambient AWS region or any deployment target is a
  China region.
