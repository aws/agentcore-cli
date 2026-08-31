# {{name}}

An AgentCore Runtime that proxies the existing Amazon Bedrock Agent
**{{agentName}}** (`{{agentId}}`, alias `{{agentAliasId}}`, region
`{{agentRegion}}`). Invocations of this runtime forward the payload's `prompt`
to the Bedrock Agent and stream its reply back, so the agent can be deployed
and invoked through AgentCore without changing it.

- `main.py` — the proxy entrypoint. The agent id, alias id, and region are
  baked in at import time and can be overridden with the `BEDROCK_AGENT_ID`,
  `BEDROCK_AGENT_ALIAS_ID`, and `BEDROCK_AGENT_REGION` environment variables.
- `bedrock-agent-policy.json` — grants the runtime's execution role
  `bedrock:InvokeAgent` on the imported agent's alias. It is wired in through
  the runtime's `additionalPolicies` entry in `agentcore/agentcore.json`.

Invoke it with a JSON payload like `{"prompt": "hello"}`.
