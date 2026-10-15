import { describe, expect, test } from "bun:test";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { TerraformProjectValidator, declaredResources } from "./preflight";

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
              statement: "permit(principal, action, resource is AgentCore::Gateway);",
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
describe("Terraform project preflight", () => {
  test("accepts the scoped connected project", () => {
    expect(() => new TerraformProjectValidator().validate(project())).not.toThrow();
    expect(declaredResources(project())).toHaveLength(7);
  });
  test("accepts a Python entrypoint with a handler suffix", () => {
    const p = project();
    p.spec.runtimes[0]!.entrypoint = "main.py:app";
    expect(() => new TerraformProjectValidator().validate(p)).not.toThrow();
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
        p.spec.runtimes[0]!.entrypoint = "main.js:app";
      },
    ],
    [
      "envVars.AGENTCORE_GATEWAY_TOOLS_AUTH_TYPE",
      (p: Project) => {
        p.spec.runtimes[0]!.envVars = [
          { name: "AGENTCORE_GATEWAY_TOOLS_AUTH_TYPE", value: "NONE" },
        ];
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
    expect(() => new TerraformProjectValidator().validate(p)).toThrow(path);
  });
});
