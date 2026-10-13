import { describe, expect, test } from "bun:test";
import type { PinnedResourceType } from "../../../handlers/project/migrate/types";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { V0AgentCoreProjectSpecSchema, type V0DeployedState } from "../../../projectSchemas/v0";
import { rawFixture, v0Fixture, validV0FixtureNames } from "../legacy/fixtures-test-support";
import { convertSpec, convertTargets, deployedResources, type HarnessFacts } from "./convertSpec";
import { F1_DEPLOYED_STATE, F1_SPEC } from "./migrate-test-support";

type Json = Record<string, unknown>;
const NEVER_DEPLOYED: V0DeployedState = { targets: {} };
const f1 = () => V0AgentCoreProjectSpecSchema.parse(structuredClone(F1_SPEC));
const f1State = () => structuredClone(F1_DEPLOYED_STATE) as V0DeployedState;

/**
 * The audit fixtures v1 validates more strictly than v0 (the schema audit; see the design doc),
 * with the field each one fails on. Every other v0-valid fixture converts cleanly.
 */
const EXPECTED_PROBLEMS: Record<string, string[]> = {
  "configbundle-branch-leading-digit.json": ["configBundles[cb1].branchName"],
  "configbundle-branch-with-dot.json": ["configBundles[cb1].branchName"],
  "credential-env-collision.json": ["credentials[svc_client_secret].name"],
  "credential-hyphen-underscore-collision.json": ["credentials[my_key].name"],
  "credential-name-1-char.json": ["credentials[k].name"],
  "credential-name-2-chars.json": ["credentials[ab].name"],
  "credential-oauth-no-discoveryUrl_import_.json": ["credentials[imported-oauth]"],
  "credential-oauth-vendor-non-custom-no-url.json": ["credentials[github]"],
  "credential-oauth-vendor-non-custom.json": ["credentials[google]"],
  "gateway-target-apigw-empty-toolDefinitions.json": [
    "agentCoreGateways[gw1].targets[apigw].toolDefinitions",
  ],
  "gateway-target-connector-outboundAuth-NONE.json": [
    "agentCoreGateways[gw1].targets[websearch].outboundAuth",
  ],
  "gateway-target-httpRuntime-with-schemaSource.json": [
    "agentCoreGateways[gw2].targets[httprt].schemaSource",
  ],
  "gateway-target-lambda-with-endpoint.json": ["agentCoreGateways[gw1].targets[lambdaTs].endpoint"],
  "gateway-target-mcpServer-empty-configurations.json": [
    "agentCoreGateways[gw1].targets[mcpExt].configurations",
  ],
  "gateway-target-mcpServer-with-passthrough.json": [
    "agentCoreGateways[gw1].targets[mcpExt].passthrough",
  ],
  "gateway-target-openapi-with-httpRuntime.json": [
    "agentCoreGateways[gw1].targets[openapi].httpRuntime",
  ],
  "gateway-target-smithy-outboundAuth-NONE.json": [
    "agentCoreGateways[gw1].targets[smithy].outboundAuth",
  ],
  "online-eval-11-evaluators.json": ["onlineEvalConfigs[oe1].evaluators"],
  "payment-connector-provider-mismatch.json": ["payments[pm1].connectors[stripe1].provider"],
  "payment-description-punctuation.json": ["payments[pm1].description"],
  "payment-duplicate-connector-names.json": ["payments[pm1].connectors[cb_manual].name"],
  "payment-jwt-discovery-not-wellknown.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.discoveryUrl",
  ],
  "payment-jwt-empty-arrays.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.allowedClients",
  ],
  "payment-jwt-scope-with-space.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.allowedScopes[0]",
  ],
  "payment-manager-case-collision.json": ["payments[PM1].name"],
  "payment-spendlimit-nonnumeric.json": ["payments[pm1].defaultSpendLimit"],
  "project-name-crewai.json": ["name"],
  "project-name-tiktoken.json": ["name"],
  "runtime-codezip-no-runtimeVersion.json": ["runtimes[agentD].runtimeVersion"],
  "runtime-container-vpc-no-vpcId.json": ["runtimes[agentB].networkConfig.vpcId"],
};

describe("convertSpec on the v0 audit fixtures", () => {
  test.each(validV0FixtureNames())("%s converts or names exactly what v1 rejects", (name) => {
    const result = convertSpec(v0Fixture(name), NEVER_DEPLOYED);
    const expected = EXPECTED_PROBLEMS[name];
    if (expected) {
      expect(result.problems.map((problem) => problem.path)).toEqual(expected);
      for (const problem of result.problems) {
        expect(problem.file).toBe("agentcore/agentcore.json");
        expect(problem.message.length).toBeGreaterThan(0);
      }
      return;
    }
    expect(result.problems).toEqual([]);
    // What gets written is a v1 spec, and reading it back changes nothing.
    const reparsed = ProjectSpecSchema.parse(structuredClone(result.json));
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(JSON.parse(JSON.stringify(result.json)));
    expect(result.json.version).toBe(2);
    expect(result.json.name).toBe(String(rawFixture(name).name));
  });

  test("every expected problem fixture exists", () => {
    const names = new Set(validV0FixtureNames());
    expect(Object.keys(EXPECTED_PROBLEMS).filter((name) => !names.has(name))).toEqual([]);
  });

  test("warns about the fields v1 drops, naming the resource", () => {
    const { warnings } = convertSpec(v0Fixture("baseline.json"), NEVER_DEPLOYED);
    expect(warnings).toEqual([
      "Dropped fields v1 doesn't use: credentials[my-oauth].usage, credentials[gw1-oauth].usage",
    ]);
  });

  test("warns about dropped unassigned targets and A/B tests", () => {
    expect(
      convertSpec(v0Fixture("top-unassignedTargets.json"), NEVER_DEPLOYED).warnings[0],
    ).toStartWith("Dropped unassigned gateway targets (u1)");
    const { warnings, json } = convertSpec(v0Fixture("top-abTests-nonempty.json"), NEVER_DEPLOYED);
    expect(warnings[0]).toStartWith("Removed abTests (ab1) from agentcore.json");
    expect("abTests" in json).toBe(false);
  });

  test("keeps tool runtimes under their v1 name", () => {
    const { json } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), NEVER_DEPLOYED);
    expect("mcpRuntimeTools" in json).toBe(false);
    expect((json.toolRuntimes as Json[])[0]?.name).toBe("rtTool");
  });
});

describe("convertSpec kept names", () => {
  test('marks the project migratedFrom "v1" and lists every deployed resource\'s v0 name', () => {
    const { pins, problems, json } = convertSpec(f1(), f1State());
    expect(problems).toEqual([]);
    const pin = (resourceType: PinnedResourceType, name: string, value: string) => ({
      resourceType,
      name,
      value,
      targets: ["default"],
    });
    expect(pins).toEqual([
      pin("runtime", "CompatAAgent", "CompatA_CompatAAgent"),
      pin("memory", "CompatAAgentMemory", "CompatA_CompatAAgentMemory"),
      pin("evaluator", "CompatAJudge", "CompatA_CompatAJudge"),
      pin("online-eval", "CompatAOnline", "CompatA_CompatAOnline"),
      pin("policy-engine", "CompatAPE", "CompatA_CompatAPE"),
      // Cedar policies keep their verbatim names, so none is listed.
      pin("config-bundle", "CompatABundle", "CompatACompatABundle"),
      pin("harness", "CompatAHarness", "CompatA_CompatAHarness"),
      pin("gateway", "CompatAGw", "CompatA-CompatAGw"),
    ]);
    // The flag keeps v0 naming for the whole project; no per-resource names are written.
    const spec = ProjectSpecSchema.parse(json);
    expect(spec.migratedFrom).toBe("v1");
    expect(Object.keys(json).slice(0, 3)).toEqual(["name", "version", "migratedFrom"]);
    expect(JSON.stringify(spec)).not.toContain("resourceName");
    expect(JSON.stringify(spec)).not.toContain("providerName");
  });

  test("marks a never-deployed project migratedFrom too", () => {
    expect(convertSpec(f1(), NEVER_DEPLOYED).json.migratedFrom).toBe("v1");
  });

  test("leaves never-deployed resources unpinned", () => {
    expect(convertSpec(f1(), NEVER_DEPLOYED).pins).toEqual([]);
  });

  test("pins what any target deployed, including gateways recorded under mcp", () => {
    const state: V0DeployedState = {
      targets: {
        dev: { resources: { memories: f1State().targets.default!.resources!.memories } },
        prod: {
          resources: {
            mcp: {
              gateways: {
                CompatAGw: { gatewayId: "compata-compatagw-abcde12345", gatewayArn: "arn:gw" },
              },
            },
          },
        },
      },
    };
    const { pins } = convertSpec(f1(), state);
    expect(pins.map((pin) => `${pin.resourceType}:${pin.value}@${pin.targets.join(",")}`)).toEqual([
      "memory:CompatA_CompatAAgentMemory@dev",
      "gateway:CompatA-CompatAGw@prod",
    ]);
  });

  test("keeps a gateway's explicit v0 resourceName in the spec, recording no name for it", () => {
    const v0 = f1();
    v0.agentCoreGateways[0]!.resourceName = "custom-gw";
    const state = f1State();
    state.targets.default!.resources!.gateways!.CompatAGw!.gatewayId = "custom-gw-xyzab12345";
    const { json, pins, problems } = convertSpec(v0, state);
    // The library prefers the spec's resourceName, so a recorded name would go unused.
    expect(pins.some((p) => p.resourceType === "gateway")).toBe(false);
    expect(problems).toEqual([]);
    expect((json.agentCoreGateways as { resourceName?: string }[])[0]?.resourceName).toBe(
      "custom-gw",
    );

    state.targets.default!.resources!.gateways!.CompatAGw!.gatewayId = "other-gw-xyzab12345";
    expect(convertSpec(v0, state).problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "gateway CompatAGw",
        message:
          "deployed as 'other-gw-xyzab12345', which doesn't match its resourceName 'custom-gw', so its name can't be kept safely",
      },
    ]);
  });

  test("reports a deployed ID that doesn't match the derived name instead of pinning it", () => {
    const state = f1State();
    state.targets.default!.resources!.runtimes!.CompatAAgent!.runtimeId = "Renamed_Agent-abc";
    const { pins, problems } = convertSpec(f1(), state);
    expect(pins.some((pin) => pin.resourceType === "runtime")).toBe(false);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtime CompatAAgent",
        message:
          "deployed as 'Renamed_Agent-abc', which doesn't match the name 'CompatA_CompatAAgent' " +
          "v0 would have given it, so its name can't be kept safely",
      },
    ]);
  });

  test("pins a deployed managed code-based evaluator's Lambda function name", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    const state: V0DeployedState = {
      targets: {
        default: {
          resources: {
            evaluators: {
              CodeJudge: { evaluatorId: "CompatA_CodeJudge-abcde12345", evaluatorArn: "arn:e" },
            },
          },
        },
      },
    };
    const { pins, problems } = convertSpec(v0, state);
    expect(problems).toEqual([]);
    expect(pins).toContainEqual({
      resourceType: "evaluator-function",
      name: "CodeJudge",
      value: "CompatA-eval-CodeJudge",
      targets: ["default"],
    });
  });

  test("does not pin the function of an evaluator whose own name can't be kept", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    const state: V0DeployedState = {
      targets: {
        default: {
          resources: {
            evaluators: {
              CodeJudge: { evaluatorId: "Other_CodeJudge-abcde12345", evaluatorArn: "arn:e" },
            },
          },
        },
      },
    };
    const { pins, problems } = convertSpec(v0, state);
    expect(pins).toEqual([]);
    expect(problems.map((problem) => problem.path)).toEqual(["evaluator CodeJudge"]);
  });

  test("leaves credential provider names to credential provisioning", () => {
    const { pins, warnings } = convertSpec(f1(), f1State());
    expect(pins.some((pin) => (pin.resourceType as string).startsWith("credential"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("providerName"))).toBe(false);
  });

  test("does not pin an evaluator function that was never deployed", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    expect(convertSpec(v0, NEVER_DEPLOYED).pins).toEqual([]);
  });

  test("does not mutate the v0 spec", () => {
    const v0 = f1();
    const before = JSON.stringify(v0);
    convertSpec(v0, f1State());
    expect(JSON.stringify(v0)).toBe(before);
  });
});

describe("deployedResources", () => {
  test("collects each target's recorded IDs per resource", () => {
    const state = f1State();
    state.targets.prod = structuredClone(state.targets.default!);
    const deployed = deployedResources(state);
    expect(deployed.runtimes.get("CompatAAgent")).toEqual([
      { target: "default", id: "CompatA_CompatAAgent-5ITOUFEJg5" },
      { target: "prod", id: "CompatA_CompatAAgent-5ITOUFEJg5" },
    ]);
    expect([...deployed.policies.keys()]).toEqual(["CompatAPE/CompatAPolicy"]);
  });
});

describe("convertTargets", () => {
  test("accepts targets v1 can read", () => {
    expect(convertTargets(rawFixture("aws-targets_default.json"))).toEqual([]);
  });

  test("accepts hyphenated target names, which v1 allows like v0 did", () => {
    expect(convertTargets(rawFixture("aws-targets_hyphen-name.json"))).toEqual([]);
  });

  test("blocks target names that differ only by case", () => {
    const problems = convertTargets(rawFixture("aws-targets_case-dup.json"));
    expect(problems[0]?.message).toContain("Duplicate deployment target name");
  });
});

describe("convertSpec pins for tool runtimes, gateway-target compute, and containers", () => {
  const recorded = (resources: Record<string, unknown>): V0DeployedState =>
    ({ targets: { default: { resources } } }) as V0DeployedState;

  test("pins deployed tool runtimes, target Lambdas, and Container runtime repositories", () => {
    const state = recorded({
      runtimes: {
        agentB: {
          runtimeId: "maxproj_agentB-abcde12345",
          runtimeArn: "arn:r",
          roleArn: "arn:role",
        },
      },
      mcp: {
        runtimes: {
          rtTool: {
            runtimeId: "maxproj_rtToolRuntime-abcde12345",
            runtimeArn: "arn:rt",
            runtimeEndpoint: "https://rt",
          },
        },
        lambdas: {
          lambdaTs: { functionName: "maxproj-lambdaTs", functionArn: "arn:fn" },
        },
      },
    });
    const { pins, problems } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), state);
    expect(problems).toEqual([]);
    const gateway = pins.find((pin) => pin.resourceType === "gateway-target-function")?.name;
    expect(pins.map(({ resourceType, value }) => ({ resourceType, value }))).toEqual([
      { resourceType: "runtime", value: "maxproj_agentB" },
      { resourceType: "runtime-repository", value: "maxproj/agentb" },
      { resourceType: "gateway-target-function", value: "maxproj-lambdaTs" },
      { resourceType: "tool-runtime", value: "maxproj_rtToolRuntime" },
    ]);
    expect(gateway).toEndWith("/lambdaTs");
    expect(pins.every((pin) => pin.targets.join() === "default")).toBe(true);
  });

  test("pins a deployed gateway target's AgentCore Runtime", () => {
    const state = recorded({
      mcp: {
        runtimes: {
          mcpRt: {
            runtimeId: "maxproj_rtToolRuntime-abcde12345",
            runtimeArn: "arn:rt",
            runtimeEndpoint: "https://rt",
          },
        },
      },
    });
    const { pins, problems } = convertSpec(
      v0Fixture("gateway-target-mcpServer-agentcoreRuntime-compute.json"),
      state,
    );
    expect(problems).toEqual([]);
    expect(pins.map(({ resourceType, value }) => ({ resourceType, value }))).toEqual([
      { resourceType: "gateway-target-runtime", value: "maxproj_rtToolRuntime" },
    ]);
    expect(pins[0]?.name).toMatch(/\/mcpRt$/);
  });

  test("refuses one Lambda name when targets recorded different ones", () => {
    const state: V0DeployedState = {
      targets: {
        dev: {
          resources: { mcp: { lambdas: { lambdaTs: { functionName: "a", functionArn: "x" } } } },
        },
        prod: {
          resources: { mcp: { lambdas: { lambdaTs: { functionName: "b", functionArn: "y" } } } },
        },
      },
    };
    const { problems } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), state);
    expect(problems.map((problem) => problem.path)).toEqual([
      expect.stringMatching(/^gateway-target-function .+\/lambdaTs$/),
    ]);
  });

  test("reports a tool runtime and a gateway target that share a name v0 records compute under", () => {
    const v0 = v0Fixture("top-mcpRuntimeTools.json");
    // The tool runtime takes the name of gateway gw1's Lambda target.
    (v0 as unknown as { mcpRuntimeTools: { name: string }[] }).mcpRuntimeTools[0]!.name =
      "lambdaTs";
    const state = recorded({
      mcp: { lambdas: { lambdaTs: { functionName: "maxproj-lambdaTs", functionArn: "arn:fn" } } },
    });
    const { pins, problems } = convertSpec(v0, state);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "gateway target 'gw1/lambdaTs', tool runtime 'lambdaTs'",
        message:
          "gateway target 'gw1/lambdaTs' and tool runtime 'lambdaTs' share the name 'lambdaTs', under which v0 records their deployed compute, so migrate can't tell which deployed function or runtime belongs to which; their names can't be kept safely",
      },
    ]);
    // Neither is pinned from the ambiguous record.
    expect(pins.some((pin) => pin.name.includes("lambdaTs"))).toBe(false);
  });

  test('carries a v0 gateway\'s protocolType "None" over unchanged', () => {
    const spec = structuredClone(F1_SPEC) as { agentCoreGateways: Record<string, unknown>[] };
    spec.agentCoreGateways[0]!.protocolType = "None";
    const { json } = convertSpec(V0AgentCoreProjectSpecSchema.parse(spec), f1State());
    expect((json.agentCoreGateways as Record<string, unknown>[])[0]?.protocolType).toBe("None");
  });

  test("checks the whole recorded ID shape, not just its prefix", () => {
    const state = f1State();
    state.targets.default!.resources!.runtimes!.CompatAAgent!.runtimeId =
      "CompatA_CompatAAgent-short";
    const { problems } = convertSpec(f1(), state);
    expect(problems.map((problem) => problem.path)).toEqual(["runtime CompatAAgent"]);
  });
});

describe("convertSpec harness pins", () => {
  test("blocks a harness v0 created outside CloudFormation", () => {
    const state = f1State();
    delete state.targets.default!.resources!.harnesses!.CompatAHarness!.provisioner;
    const { pins, problems } = convertSpec(f1(), state);
    expect(pins.some((pin) => pin.resourceType === "harness")).toBe(false);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "harness CompatAHarness",
        message:
          "was created outside CloudFormation; remove it with " +
          "'npx @aws/agentcore@0 remove harness CompatAHarness --keep' (or delete it) before migrating",
      },
    ]);
  });

  test("pins the execution role v0 created, checked against the recorded role ARN", () => {
    const { pins, problems } = convertSpec(f1(), f1State(), { CompatAHarness: {} });
    expect(problems).toEqual([]);
    expect(pins).toContainEqual({
      resourceType: "harness-role",
      name: "CompatAHarness",
      value: "CompatA_CompatAHarness",
      targets: ["default"],
    });

    const state = f1State();
    state.targets.default!.resources!.harnesses!.CompatAHarness!.roleArn =
      "arn:aws:iam::998846730471:role/Other";
    const mismatched = convertSpec(f1(), state, { CompatAHarness: {} });
    expect(mismatched.problems.map((problem) => problem.path)).toEqual([
      "harness-role CompatAHarness",
    ]);
  });

  test("pins no role for a harness with its own execution role", () => {
    const { pins } = convertSpec(f1(), f1State(), {
      CompatAHarness: { executionRoleArn: "arn:aws:iam::998846730471:role/Mine" },
    });
    expect(pins.some((pin) => pin.resourceType === "harness-role")).toBe(false);
  });

  test("pins the ECR repository only when the libraries create one", () => {
    const repository = (facts: HarnessFacts) =>
      convertSpec(f1(), f1State(), { CompatAHarness: facts }).pins.find(
        (pin) => pin.resourceType === "harness-repository",
      );
    // The v0 app (v0.16.0 and later) passes hasDockerfile and the code location.
    const built = { dockerfile: "Dockerfile", hasDockerfile: true, codeLocation: "app/h" };
    expect(repository(built)).toEqual({
      resourceType: "harness-repository",
      name: "CompatAHarness",
      value: "compata/harness-compataharness",
      targets: ["default"],
    });
    // A prebuilt image, or an app that builds the container itself, creates no repository.
    expect(repository({ ...built, containerUri: "public.ecr.aws/x/y" })).toBeUndefined();
    expect(repository({ dockerfile: "Dockerfile", codeLocation: "app/h" })).toBeUndefined();
    expect(repository({ dockerfile: "Dockerfile", hasDockerfile: true })).toBeUndefined();
  });
});

describe("convertSpec dropped fields", () => {
  test("blocks a field v1 drops from a deployed resource, and only warns otherwise", () => {
    // v1 drops a runtime's capacityProviderConfiguration (preflight also blocks it).
    const v0 = v0Fixture("runtime-capacityProviderArn-only.json");
    const deployed: V0DeployedState = {
      targets: {
        default: {
          resources: {
            runtimes: {
              agentB: { runtimeId: "maxproj_agentB-abcde12345", runtimeArn: "a", roleArn: "r" },
            },
          },
        },
      },
    };
    const result = convertSpec(v0, deployed);
    expect(result.deployedChanges).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtimes[agentB].capacityProviderConfiguration",
        message: "v1 drops this field, which changes the deployed resource on the next deploy",
      },
    ]);
    // A credential's usage label never reached AWS, so it only warns.
    expect(result.warnings).toContain(
      "Dropped fields v1 doesn't use: credentials[my-oauth].usage, credentials[gw1-oauth].usage",
    );

    const undeployed = convertSpec(v0, NEVER_DEPLOYED);
    expect(undeployed.deployedChanges).toEqual([]);
    expect(undeployed.warnings[0]).toContain("runtimes[agentB].capacityProviderConfiguration");
  });
});
