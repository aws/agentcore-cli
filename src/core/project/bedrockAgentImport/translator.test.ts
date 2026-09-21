import { describe, expect, test } from "bun:test";
import { LangGraphBedrockAgentTranslator } from "./langGraphTranslator";
import { StrandsBedrockAgentTranslator } from "./strandsTranslator";
import type { BedrockAgentImportRequest, BedrockAgentSnapshot } from "./types";

const request: BedrockAgentImportRequest = {
  runtimeName: "ImportedSupport",
  region: "us-east-1",
  agentId: "A1B2C3D4E5",
  agentAliasId: "TSTALIASID",
  framework: "strands",
  memory: "longAndShortTerm",
};

function snapshot(overrides: Partial<BedrockAgentSnapshot> = {}): BedrockAgentSnapshot {
  return {
    region: "us-east-1",
    sourceAgentId: "A1B2C3D4E5",
    sourceAgentVersion: "7",
    agentName: "SupportAgent",
    description: "Handles customer support.",
    foundationModel: "us.amazon.nova-lite-v1:0",
    instruction: 'Answer support questions. Never emit """.',
    inferenceConfiguration: { temperature: 0.2, topP: 0.9, maximumLength: 1024 },
    hasPromptOverrides: true,
    guardrail: { identifier: "GR123", version: "1" },
    sourceMemoryEnabled: true,
    actionGroups: [
      {
        name: "weather",
        functions: [
          {
            name: "get-weather",
            description: "Get current weather.",
            parameters: {
              city: { type: "string", required: true },
              days: { type: "integer", required: false },
            },
          },
        ],
        hasApiSchema: false,
        hasLambdaExecutor: true,
        returnsControl: false,
      },
      {
        name: "code-interpreter",
        parentActionSignature: "AMAZON.CodeInterpreter",
        functions: [],
        hasApiSchema: false,
        hasLambdaExecutor: false,
        returnsControl: false,
      },
    ],
    knowledgeBases: [
      {
        id: "KB123",
        name: "Product Docs",
        description: "Product documentation.",
        arn: "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123",
      },
    ],
    collaborators: [],
    notes: [],
    ...overrides,
  };
}

describe("StrandsBedrockAgentTranslator", () => {
  test("generates owned Strands code and documents required permissions", () => {
    const source = snapshot();
    const plan = new StrandsBedrockAgentTranslator(source, request).translate();

    expect(plan.files["main.py"]).toContain("from strands import Agent, tool");
    expect(plan.files["main.py"]).toContain('model_id="us.amazon.nova-lite-v1:0"');
    expect(plan.files["main.py"]).toContain("temperature=0.2");
    expect(plan.files["main.py"]).toContain("max_tokens=1024");
    expect(plan.files["main.py"]).toContain("def get_weather(city: str, days: int | None = None)");
    expect(plan.files["main.py"]).toContain("def retrieve_Product_Docs(query: str)");
    expect(plan.files["main.py"]).toContain("AgentCoreCodeInterpreter().code_interpreter");
    expect(plan.files["main.py"]).toContain("await asyncio.to_thread");
    // The generated agent must never route back through the source Bedrock Agent.
    expect(plan.files["main.py"]).not.toContain("invoke_agent(" + "agentId=");
    expect(plan.files["main.py"]).not.toContain("client.invoke_agent");
    expect(plan.files["main.py"]).not.toContain("bedrock:InvokeAgent");
    // Knowledge-base access is documented as manual follow-up, not generated as an IAM policy.
    expect(Object.keys(plan.files)).not.toContain("bedrock-knowledge-base-policy.json");
    expect(plan.files["IMPORT_NOTES.md"]).toContain(
      "Grant the Runtime execution role bedrock:Retrieve on: " +
        "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123.",
    );
    expect(plan.files["IMPORT_NOTES.md"]).toContain("action-group implementation");
    expect(plan.files["IMPORT_NOTES.md"]).toContain("Lambda executor");
    expect(plan.files["IMPORT_NOTES.md"]).toContain("Strands guardrail");
  });

  test("pins a code-interpreter dependency that can coexist with strands-agents 1.x", () => {
    const pyproject = new StrandsBedrockAgentTranslator(snapshot(), request).translate().files[
      "pyproject.toml"
    ]!;

    // 0.1.x caps strands-agents below 1.0, so the project would not resolve at all.
    expect(pyproject).toContain("strands-agents-tools ~= 0.2.16");
    expect(pyproject).not.toContain("strands-agents-tools ~= 0.1");
  });

  test("keeps generated state to the repository's per-session agent cache", () => {
    const main = new StrandsBedrockAgentTranslator(snapshot(), request).translate().files[
      "main.py"
    ]!;

    expect(main).toContain("_agents = OrderedDict()");
    expect(main).toContain('key = f"{session_id}/{user_id}"');
    expect(main).not.toContain("contextvars");
    expect(main).not.toContain("threading");
    expect(main).not.toContain("_session_locks");
    expect(main.match(/asyncio\.to_thread/g)).toHaveLength(1);
  });

  test("escapes service-controlled strings embedded in Python", () => {
    const source = snapshot();
    const main = new StrandsBedrockAgentTranslator(source, {
      ...request,
      memory: "none",
    }).translate().files["main.py"]!;

    expect(main).toContain('SYSTEM_PROMPT = """Answer support questions. Never emit \\"\\"\\"."""');
    // An unescaped instruction would terminate the triple-quoted literal early.
    expect(main).not.toContain('Never emit """.');
  });

  test("generates collaborator modules without invoking the source alias", () => {
    const source = snapshot({
      collaborators: [
        {
          name: "billing",
          instruction: "Handle billing.",
          relayConversationHistory: "TO_COLLABORATOR",
          agent: snapshot({
            sourceAgentId: "B1B2B3B4B5",
            sourceAgentVersion: "2",
            agentName: "BillingAgent",
            collaborators: [],
          }),
        },
      ],
    });
    const plan = new StrandsBedrockAgentTranslator(source, {
      ...request,
      memory: "none",
    }).translate();

    expect(plan.files["strands_collaborator_billing.py"]).toContain(
      'Generated from Bedrock Agent "BillingAgent" version "2"',
    );
    expect(plan.files["main.py"]).toContain(
      "from strands_collaborator_billing import invoke_agent as invoke_billing_agent",
    );
    expect(plan.files["main.py"]).not.toContain("contextvars");
    expect(plan.files["IMPORT_NOTES.md"]).toContain("collaborator session scope");
  });

  // relayConversationHistory=TO_COLLABORATOR means the source agent forwarded its conversation to
  // the collaborator, so the generated tool must too.
  test("relays the caller's conversation to a TO_COLLABORATOR collaborator", () => {
    const plan = new StrandsBedrockAgentTranslator(
      snapshot({
        collaborators: [
          {
            name: "billing",
            instruction: "Handle billing.",
            relayConversationHistory: "TO_COLLABORATOR",
            agent: snapshot({ agentName: "BillingAgent", collaborators: [] }),
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate();

    expect(plan.files["main.py"]).toContain("from strands.types.tools import ToolContext");
    expect(plan.files["main.py"]).toContain("@tool(context=True)");
    expect(plan.files["main.py"]).toContain("list(tool_context.agent.messages[:-1])");
    // Only the collaborator module accepts relayed history; the root is called by the entrypoint.
    expect(plan.files["strands_collaborator_billing.py"]).toContain("relayed_messages");
    expect(plan.files["strands_collaborator_billing.py"]).toContain(
      "agent.messages = list(relayed_messages)",
    );
    expect(plan.files["main.py"]).not.toContain("relayed_messages: list");
    expect(plan.files["IMPORT_NOTES.md"]).not.toContain("relayed conversation history");
  });

  test("does not relay to a collaborator the source agent did not relay to", () => {
    const plan = new StrandsBedrockAgentTranslator(
      snapshot({
        collaborators: [
          {
            name: "weather",
            instruction: "Weather.",
            relayConversationHistory: "DISABLED",
            agent: snapshot({ agentName: "WeatherAgent", collaborators: [] }),
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate();

    // Collaborator modules always accept the optional parameter; only a relaying parent passes it.
    expect(plan.files["main.py"]).toContain(
      "invoke_weather_agent(query, COLLABORATOR_SESSION, COLLABORATOR_SESSION)",
    );
    expect(plan.files["main.py"]).not.toContain("ToolContext");
    expect(plan.files["main.py"]).not.toContain("@tool(context=True)");
  });

  test("gives only the root module the Runtime entrypoint", () => {
    const plan = new StrandsBedrockAgentTranslator(
      snapshot({
        collaborators: [
          {
            name: "billing",
            instruction: "Handle billing.",
            agent: snapshot({ agentName: "BillingAgent", collaborators: [] }),
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate();

    expect(plan.files["main.py"]).toContain("app = BedrockAgentCoreApp()");
    expect(plan.files["main.py"]).toContain("@app.entrypoint");

    // The root imports this module, so a second app/entrypoint here would register on import.
    const collaborator = plan.files["strands_collaborator_billing.py"]!;
    expect(collaborator).not.toContain("BedrockAgentCoreApp");
    expect(collaborator).not.toContain("@app.entrypoint");
    expect(collaborator).not.toContain("__main__");
    expect(collaborator).toContain("def invoke_agent(");
  });

  test("reports collaborator follow-up alongside the root's", () => {
    const plan = new StrandsBedrockAgentTranslator(
      snapshot({
        knowledgeBases: [],
        actionGroups: [],
        collaborators: [
          {
            name: "billing",
            instruction: "Handle billing.",
            agent: snapshot({
              agentName: "BillingAgent",
              collaborators: [],
              knowledgeBases: [
                { id: "KB999", name: "Billing Docs", arn: "arn:aws:bedrock:eu-west-1:1:kb/KB999" },
              ],
            }),
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate();

    const notes = plan.files["IMPORT_NOTES.md"]!;
    expect(notes).toContain("knowledge-base IAM (collaborator 'BillingAgent')");
    expect(notes).toContain("arn:aws:bedrock:eu-west-1:1:kb/KB999");
  });

  test("retrieves a knowledge base from its own region, not the agent's", () => {
    const main = new StrandsBedrockAgentTranslator(
      snapshot({
        knowledgeBases: [
          {
            id: "KB123",
            name: "Docs",
            arn: "arn:aws:bedrock:eu-west-1:111122223333:knowledge-base/KB123",
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate().files["main.py"]!;

    expect(main).toContain('region_name="eu-west-1"');
  });

  test("depends on the code-interpreter package when only a collaborator uses it", () => {
    const plan = new StrandsBedrockAgentTranslator(
      snapshot({
        actionGroups: [],
        collaborators: [
          {
            name: "coder",
            instruction: "Run code.",
            agent: snapshot({
              agentName: "CoderAgent",
              collaborators: [],
              actionGroups: [
                {
                  name: "ci",
                  parentActionSignature: "AMAZON.CodeInterpreter",
                  functions: [],
                  hasApiSchema: false,
                  hasLambdaExecutor: false,
                  returnsControl: false,
                },
              ],
            }),
          },
        ],
      }),
      { ...request, memory: "none" },
    ).translate();

    expect(plan.files["main.py"]).not.toContain("AgentCoreCodeInterpreter");
    expect(plan.files["strands_collaborator_coder.py"]).toContain("AgentCoreCodeInterpreter");
    expect(plan.files["pyproject.toml"]).toContain("strands-agents-tools");
  });
});

describe("LangGraphBedrockAgentTranslator", () => {
  test("generates session-isolated LangGraph code with guardrails", () => {
    const source = snapshot();
    const plan = new LangGraphBedrockAgentTranslator(source, {
      ...request,
      framework: "langgraph",
      memory: "none",
    }).translate();

    expect(plan.files["main.py"]).toContain("from langgraph.prebuilt import create_react_agent");
    expect(plan.files["main.py"]).toContain('{"configurable": {"thread_id": session_id}}');
    expect(plan.files["main.py"]).not.toContain('"thread_id": "1"');
    expect(plan.files["main.py"]).toContain(
      'guardrails={"guardrailIdentifier":"GR123","guardrailVersion":"1"}',
    );
    expect(plan.files["main.py"]).toContain("await asyncio.to_thread");
    expect(plan.files["IMPORT_NOTES.md"]).toContain("LangGraph code interpreter");
    // Compatible-release pinning, matching the repository's scaffolded templates.
    expect(plan.files["pyproject.toml"]).toContain("langgraph ~= 1.0");
    expect(plan.files["pyproject.toml"]).not.toContain("strands-agents ~=");
    expect(plan.files["pyproject.toml"]).not.toMatch(/[a-z-]+ >=/);
  });

  // langchain_aws raises on ANY `arn:` model id rather than looking inside it, so ChatBedrock
  // needs the provider supplied whenever the source agent used an ARN.
  test("supplies the provider named by a foundation-model ARN", () => {
    const plan = new LangGraphBedrockAgentTranslator(
      snapshot({
        foundationModel:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0",
      }),
      { ...request, framework: "langgraph", memory: "none" },
    ).translate();

    expect(plan.files["main.py"]).toContain('provider="anthropic"');
    expect(plan.files["IMPORT_NOTES.md"]).not.toContain("LangGraph model provider");
  });

  test("asks for the provider when the ARN does not name one", () => {
    const plan = new LangGraphBedrockAgentTranslator(
      snapshot({
        foundationModel: "arn:aws:bedrock:us-east-1:1:application-inference-profile/9f8d7s6a",
      }),
      { ...request, framework: "langgraph", memory: "none" },
    ).translate();

    expect(plan.files["main.py"]).toContain('# provider="anthropic",');
    expect(plan.files["IMPORT_NOTES.md"]).toContain("LangGraph model provider");
  });

  test("leaves a plain model id alone, since langchain_aws infers it", () => {
    const plan = new LangGraphBedrockAgentTranslator(snapshot(), {
      ...request,
      framework: "langgraph",
      memory: "none",
    }).translate();

    expect(plan.files["main.py"]).not.toContain("provider=");
    expect(plan.files["IMPORT_NOTES.md"]).not.toContain("LangGraph model provider");
  });
});

test.each([
  ["strands", StrandsBedrockAgentTranslator, "memory.py"],
  ["langgraph", LangGraphBedrockAgentTranslator, "main.py"],
] as const)(
  "%s reads the memory id under the default memory's truncated name",
  (framework, Translator, file) => {
    const plan = new Translator(snapshot(), {
      ...request,
      framework,
      runtimeName: "a".repeat(48),
    }).translate();

    expect(plan.files[file]).toContain(
      `MEMORY_ID = os.getenv("AGENTCORE_MEMORY_${"A".repeat(42)}MEMORY_ID")`,
    );
  },
);
