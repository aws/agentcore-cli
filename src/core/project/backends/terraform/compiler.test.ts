import { describe, expect, test } from "bun:test";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import {
  TerraformCompiler,
  declaredResources,
  type TerraformAssets,
  type TerraformConfiguration,
} from "./compiler";

const target = { name: "test", account: "111122223333", region: "us-east-1" } as const;
const archive = { path: "/tmp/agent.zip", hash: "a".repeat(64) };
const assets: TerraformAssets = {
  runtimes: { Agent: archive },
  gatewayTargets: { "tools/echo": archive },
};
function project(): Project {
  return {
    name: "Example",
    rootPath: "/tmp/example",
    spec: ProjectSpecSchema.parse({
      name: "Example",
      version: 2,
      managedBy: "Terraform",
      runtimes: [
        {
          name: "Agent",
          build: "CodeZip",
          runtimeVersion: "PYTHON_3_12",
          codeLocation: "src/agent",
          entrypoint: "main.py",
        },
      ],
      memories: [{ name: "Memory", eventExpiryDuration: 7, strategies: [{ type: "SEMANTIC" }] }],
      policyEngines: [
        {
          name: "Rules",
          policies: [
            {
              name: "Allow",
              statement: "permit(principal, action, resource);",
              enforcementMode: "LOG_ONLY",
            },
          ],
        },
      ],
      agentCoreGateways: [
        {
          name: "tools",
          authorizerType: "AWS_IAM",
          policyEngineConfiguration: { policyEngineName: "Rules", mode: "LOG_ONLY" },
          targets: [
            {
              name: "echo",
              targetType: "lambda",
              toolDefinitions: [
                {
                  name: "echo",
                  description: "Echo input",
                  inputSchema: {
                    type: "object",
                    properties: { message: { type: "string" }, optional: { type: "boolean" } },
                    required: ["message"],
                  },
                },
              ],
              compute: {
                host: "Lambda",
                pythonVersion: "PYTHON_3_12",
                implementation: { language: "Python", path: "src/tool", handler: "main.handler" },
              },
            },
          ],
        },
      ],
      onlineEvalConfigs: [
        { name: "Quality", agent: "Agent", samplingRate: 100, evaluators: ["Builtin.Helpfulness"] },
      ],
    }),
  };
}
function resource(config: TerraformConfiguration, type: string): Record<string, any> {
  return Object.values(config.resource[type]!)[0]!;
}
function compile(p = project()): TerraformConfiguration {
  return new TerraformCompiler().compile(p, target, assets);
}

describe("Terraform project compilation", () => {
  test("connects runtime, memory, gateway, policies and evaluation with Terraform references", () => {
    const config = compile();
    const runtime = resource(config, "awscc_bedrockagentcore_runtime");
    const gateway = resource(config, "awscc_bedrockagentcore_gateway");
    const policy = resource(config, "awscc_bedrockagentcore_policy");
    const evaluation = resource(config, "awscc_bedrockagentcore_online_evaluation_config");
    const tool = resource(config, "aws_bedrockagentcore_gateway_target");
    expect(runtime.environment_variables.MEMORY_MEMORY_ID).toMatch(
      /^\$\{awscc_bedrockagentcore_memory\./,
    );
    expect(runtime.environment_variables.AGENTCORE_GATEWAY_TOOLS_URL).toMatch(
      /^\$\{awscc_bedrockagentcore_gateway\./,
    );
    expect(runtime.environment_variables.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(gateway.exception_level).toBeUndefined();
    expect(gateway.policy_engine_configuration.arn).toMatch(
      /^\$\{awscc_bedrockagentcore_policy_engine\./,
    );
    expect(gateway.policy_engine_configuration.mode).toBe("LOG_ONLY");
    expect(policy.definition).toEqual({
      policy: { statement: "permit(principal, action, resource);" },
    });
    expect(policy.enforcement_mode).toBe("LOG_ONLY");
    expect(evaluation.data_source_config.cloudwatch_logs.log_group_names[0]).toMatch(
      /^\$\{aws_cloudwatch_log_group\./,
    );
    expect(evaluation.evaluators).toEqual([{ evaluator_id: "Builtin.Helpfulness" }]);
    expect(tool.gateway_identifier).toMatch(/^\$\{awscc_bedrockagentcore_gateway\./);
    expect(tool.target_configuration[0].mcp[0].lambda[0].lambda_arn).toMatch(
      /^\$\{aws_lambda_function\./,
    );
    expect(config.output.project_resources!.value).toHaveLength(7);
    expect(declaredResources(project())).toHaveLength(7);
    expect(config.provider.aws).toEqual({
      region: "us-east-1",
      allowed_account_ids: [target.account],
    });
  });

  test("escapes literal Terraform interpolation in customer text without escaping resource references", () => {
    const p = project();
    p.spec.runtimes[0]!.description = '${file("secret")} %{if true}';
    p.spec.runtimes[0]!.envVars = [{ name: "CUSTOM", value: "${var.customer}" }];
    p.spec.policyEngines[0]!.policies[0]!.statement =
      'permit(principal, action, resource) when { context.value == "${value}" };';
    const config = compile(p);
    const runtime = resource(config, "awscc_bedrockagentcore_runtime");
    expect(runtime.description).toBe('$${file("secret")} %%{if true}');
    expect(runtime.environment_variables.CUSTOM).toBe("$${var.customer}");
    expect(runtime.environment_variables.MEMORY_MEMORY_ID).toStartWith("${awscc_");
    expect(resource(config, "awscc_bedrockagentcore_policy").definition.policy.statement).toContain(
      '"$${value}"',
    );
  });

  test("reordering resources preserves addresses and changes only output ordering", () => {
    const p = project();
    p.spec.memories.push({ ...p.spec.memories[0]!, name: "Second" });
    const first = compile(p);
    p.spec.memories.reverse();
    const second = compile(p);
    expect(second.resource).toEqual(first.resource);
    expect(Object.keys(second.resource.awscc_bedrockagentcore_memory!)).toEqual(
      Object.keys(first.resource.awscc_bedrockagentcore_memory!).reverse(),
    );
  });

  test("configuration and archive updates preserve runtime addresses", () => {
    const p = project();
    const first = compile(p);
    p.spec.runtimes[0]!.description = "updated";
    const updated = new TerraformCompiler().compile(p, target, {
      ...assets,
      runtimes: { Agent: { ...archive, hash: "b".repeat(64) } },
    });
    expect(Object.keys(first.resource.awscc_bedrockagentcore_runtime!)).toEqual(
      Object.keys(updated.resource.awscc_bedrockagentcore_runtime!),
    );
    expect(Object.keys(first.resource.aws_s3_object!)).toEqual(
      Object.keys(updated.resource.aws_s3_object!),
    );
    expect(JSON.stringify(updated.resource.aws_s3_object)).toContain("b".repeat(64));
  });

  test("empty project generates no remaining support infrastructure for teardown", () => {
    const p = project();
    p.spec = ProjectSpecSchema.parse({ name: p.name, version: 2, managedBy: "Terraform" });
    const config = compile(p);
    expect(config.resource).toEqual({});
    expect(config.output.project_resources!.value).toEqual([]);
  });

  test("permissions and code storage are scoped to the project's owned resources", () => {
    const config = compile();
    const bucket = resource(config, "aws_s3_bucket_public_access_block");
    expect(bucket.block_public_acls).toBe(true);
    expect(bucket.block_public_policy).toBe(true);
    const policies = Object.values(config.resource.aws_iam_role_policy!).map((entry) =>
      JSON.parse(entry.policy as string),
    );
    const memoryGrant = policies
      .flatMap((entry) => entry.Statement)
      .find((entry) => entry.Action?.includes("bedrock-agentcore:CreateEvent"));
    expect(memoryGrant.Resource[0]).toStartWith("${awscc_bedrockagentcore_memory.");
    const invocation = policies
      .flatMap((entry) => entry.Statement)
      .find((entry) => entry.Action?.includes("lambda:InvokeFunction"));
    expect(invocation.Resource[0]).toStartWith("${aws_lambda_function.");
    const evaluatorGrant = policies
      .flatMap((entry) => entry.Statement)
      .find((entry) => entry.Action?.includes("bedrock-agentcore:GetEvaluator"));
    expect(evaluatorGrant.Resource).toEqual([
      "arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness",
    ]);
    const traceGrant = policies
      .flatMap((entry) => entry.Statement)
      .find((entry) => entry.Action?.includes("logs:PutResourcePolicy"));
    expect(traceGrant.Resource[0]).toContain("/aws/bedrock-agentcore/runtimes/Example_test_Agent-");
    const trust = Object.values(config.resource.aws_iam_role!)
      .map((entry) => JSON.parse(entry.assume_role_policy as string))
      .flatMap((entry) => entry.Statement)
      .find((entry) => entry.Principal.Service === "bedrock-agentcore.amazonaws.com");
    expect(trust.Condition.StringEquals["aws:SourceAccount"]).toBe(target.account);
  });

  test("preserves required tool properties and deep JSON schemas", () => {
    const p = project();
    const tool = p.spec.agentCoreGateways[0]!.targets[0]!.toolDefinitions![0]!;
    tool.inputSchema.properties!.deep = {
      type: "object",
      properties: {
        child: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
      required: ["child"],
    };
    const result = resource(compile(p), "aws_bedrockagentcore_gateway_target")
      .target_configuration[0].mcp[0].lambda[0].tool_schema[0].inline_payload[0].input_schema[0];
    expect(result.property.find((entry: any) => entry.name === "message").required).toBe(true);
    expect(result.property.find((entry: any) => entry.name === "optional").required).toBe(false);
    const deep = result.property.find((entry: any) => entry.name === "deep").property[0];
    expect(deep.required).toBe(true);
    expect(JSON.parse(deep.properties_json)).toEqual({
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });

  test("fails when a required artifact is absent", () => {
    expect(() =>
      new TerraformCompiler().compile(project(), target, { runtimes: {}, gatewayTargets: {} }),
    ).toThrow("Missing packaged Terraform artifact");
  });

  test("represents array items under object properties using the provider's intermediate blocks", () => {
    const p = project();
    const tool = p.spec.agentCoreGateways[0]!.targets[0]!.toolDefinitions![0]!;
    tool.inputSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    };
    const input = resource(compile(p), "aws_bedrockagentcore_gateway_target")
      .target_configuration[0].mcp[0].lambda[0].tool_schema[0].inline_payload[0].input_schema[0];
    expect(input.property[0].items[0].properties_json).toBeUndefined();
    expect(input.property[0].items[0].property).toEqual([
      { name: "value", type: "string", required: true, description: undefined },
    ]);
  });

  test.each([
    [
      "migratedFrom",
      (p: Project) => {
        p.spec.migratedFrom = "v1";
      },
    ],
    [
      "runtimes[Agent].build",
      (p: Project) => {
        p.spec.runtimes[0]!.build = "Container";
      },
    ],
    [
      "runtimes[Agent].executionRoleArn",
      (p: Project) => {
        p.spec.runtimes[0]!.executionRoleArn = "arn:aws:iam::111122223333:role/existing";
      },
    ],
    [
      "runtimes[Agent].networkMode",
      (p: Project) => {
        p.spec.runtimes[0]!.networkMode = "VPC";
      },
    ],
    [
      "runtimes[Agent].runtimeVersion",
      (p: Project) => {
        p.spec.runtimes[0]!.runtimeVersion = "NODE_22";
      },
    ],
    [
      "runtimes[Agent].entrypoint",
      (p: Project) => {
        p.spec.runtimes[0]!.entrypoint = "main.py:app";
      },
    ],
    [
      "agentCoreGateways[tools].authorizerType",
      (p: Project) => {
        p.spec.agentCoreGateways[0]!.authorizerType = "NONE";
      },
    ],
    [
      "onlineEvalConfigs[Quality].evaluators",
      (p: Project) => {
        p.spec.onlineEvalConfigs[0]!.evaluators = ["Custom"];
      },
    ],
    [
      "onlineEvalConfigs[Quality].agent",
      (p: Project) => {
        p.spec.runtimes[0]!.instrumentation = { enableOtel: false };
      },
    ],
    [
      "envVars.MEMORY_MEMORY_ID",
      (p: Project) => {
        p.spec.runtimes[0]!.envVars = [{ name: "MEMORY_MEMORY_ID", value: "wrong" }];
      },
    ],
    [
      "memories[memory].name",
      (p: Project) => {
        p.spec.memories.push({ ...p.spec.memories[0]!, name: "memory" });
      },
    ],
    [
      "envVars.OTEL_SERVICE_NAME",
      (p: Project) => {
        p.spec.runtimes[0]!.envVars = [{ name: "OTEL_SERVICE_NAME", value: "other" }];
      },
    ],
    [
      "inputSchema.required",
      (p: Project) => {
        p.spec.agentCoreGateways[0]!.targets[0]!.toolDefinitions![0]!.inputSchema.required = [
          "undeclared",
        ];
      },
    ],
  ] as const)("rejects unsupported %s before packaging or deployment", (path, change) => {
    const p = project();
    change(p);
    expect(() => new TerraformCompiler().preflight(p)).toThrow(path);
  });
});
