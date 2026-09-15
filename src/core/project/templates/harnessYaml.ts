import { stringify } from "yaml";
import type { HarnessSpec } from "../../../projectSchemas/harness";

const TOOL_EXAMPLES = [
  { name: "code_interpreter", type: "agentcore_code_interpreter" },
  { name: "browser", type: "agentcore_browser" },
  {
    name: "research",
    type: "remote_mcp",
    config: { remoteMcp: { url: "https://mcp.example.com/mcp" } },
  },
  {
    name: "company_tools",
    type: "agentcore_gateway",
    config: {
      agentCoreGateway: {
        gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/example-1234567890",
        outboundAuth: { awsIam: {} },
      },
    },
  },
];

const OPTIONAL_SECTIONS = [
  {
    comment:
      "Tool patterns: @<server-name>/<tool-name> or @builtin.\nThis controls agent tool selection, not IAM permissions.",
    values: { allowedTools: ["@builtin", "@research/search"] },
  },
  {
    comment: "Skill path sources refer to files already present in the runtime container.",
    values: {
      skills: [
        { s3Uri: "s3://your-skills-bucket/skills/research/" },
        { gitUrl: "https://github.com/your-org/agent-skills.git", path: "skills/research" },
        { path: "/opt/skills/research" },
      ],
    },
  },
  {
    comment: "Execution limits apply per invocation, across all model calls.",
    values: { maxIterations: 15, maxTokens: 20000, timeoutSeconds: 300 },
  },
  {
    comment: "Truncation changes the context sent to the model, not the saved memory.",
    values: {
      truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 40 } } },
    },
  },
  {
    comment:
      "dockerfile and containerUri are mutually exclusive. With neither set, the\nservice-provided environment is used. Dockerfile paths are relative to this directory.",
    values: {
      dockerfile: "Dockerfile",
      containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest",
    },
  },
  {
    comment: "Environment values are stored in plaintext.",
    values: { environmentVariables: { LOG_LEVEL: "info" } },
  },
  {
    comment: "Deployment creates a role when executionRoleArn is absent.",
    values: { executionRoleArn: "arn:aws:iam::123456789012:role/MyHarnessRole" },
  },
  { comment: "Tags", values: { tags: { team: "support", environment: "development" } } },
];

/** Serializes supplied values separately from inactive examples, so examples cannot become defaults. */
export class HarnessYamlRenderer {
  render(spec: HarnessSpec & { systemPrompt: string }): string {
    const sections = [
      "# Optional settings are shown with example values.\n",
      stringify({ name: spec.name }),
      this.comment("Inline prompt text or a file:// path relative to this YAML file.") +
        stringify({ systemPrompt: spec.systemPrompt }),
      this.comment("Model") +
        stringify({ model: spec.model }) +
        this.examples(
          { maxTokens: 4096 },
          spec.model,
          "  ",
          "Output tokens per model call, rather than across the whole invocation.",
        ),
      this.comment(
        "Tools\nCode Interpreter and Browser use built-in resources when no ARN is specified.\nawsIam uses the harness execution role, which must allow Gateway invocation.\nhttps://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html",
      ) +
        (spec.tools.length
          ? stringify({ tools: spec.tools })
          : this.comment(stringify({ tools: TOOL_EXAMPLES }).trimEnd())),
    ];
    const rendered = new Set(["name", "systemPrompt", "model", "tools", "memory"]);
    for (const section of OPTIONAL_SECTIONS) {
      let body = this.comment(section.comment);
      for (const [key, example] of Object.entries(section.values)) {
        rendered.add(key);
        const value = spec[key as keyof HarnessSpec];
        body +=
          value === undefined || (key === "skills" && Array.isArray(value) && value.length === 0)
            ? this.comment(stringify({ [key]: example }).trimEnd())
            : stringify({ [key]: value });
      }
      sections.push(body);
      if ("skills" in section.values) sections.push(this.memory(spec.memory));
    }
    for (const [key, value] of Object.entries(spec)) {
      if (!rendered.has(key) && value !== undefined) sections.push(stringify({ [key]: value }));
    }
    return sections.join("\n");
  }

  private memory(memory: HarnessSpec["memory"]): string {
    return (
      this.comment(
        "Memory\nhttps://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html\nAlternatives: existing (name or ARN), disabled.",
      ) +
      stringify({ memory }) +
      (memory?.mode === "managed"
        ? this.examples(
            { strategies: ["SEMANTIC", "SUMMARIZATION"], eventExpiryDuration: 30 },
            memory,
            "  ",
            "Managed-memory settings. Absent values use service defaults.\nEvent retention is in days.",
          )
        : "") +
      this.examples(
        {
          name: "ConversationMemory",
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/example-1234567890",
        },
        memory ?? {},
        "  ",
        "Existing-memory reference: project resource name or external ARN.",
      )
    );
  }

  private comment(text: string, indent = ""): string {
    return text
      .split("\n")
      .map((line) => `${indent}#${line ? ` ${line}` : ""}\n`)
      .join("");
  }

  private examples(
    examples: Record<string, unknown>,
    actual: object,
    indent: string,
    semantics: string,
  ): string {
    const missing = Object.fromEntries(
      Object.entries(examples).filter(([key]) => !(key in actual)),
    );
    return Object.keys(missing).length
      ? this.comment(semantics, indent) + this.comment(stringify(missing).trimEnd(), indent)
      : "";
  }
}
