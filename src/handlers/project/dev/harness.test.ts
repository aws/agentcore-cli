import { describe, expect, test } from "bun:test";
import type { Harness } from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectStateError } from "../../../errors";
import { TestCoreClient } from "../../../testing";
import type { Project } from "../types";
import { createHarnessDevAws } from "./harness";

const project = (): Project => ({
  name: "test-project",
  rootPath: "/workspace/project",
  spec: {} as Project["spec"],
});

describe("createHarnessDevAws", () => {
  const credentials = async () => ({ accessKeyId: "key", secretAccessKey: "secret" });
  const target = { name: "staging", account: "111122223333", region: "eu-west-1" } as const;

  test("deployedHarness reads the deployed harness, or nothing when the target is not deployed", async () => {
    const core = new TestCoreClient();
    core.projectManager.resolveDeployedResource = async (_project, input) => ({
      resourceType: input.resourceType,
      name: input.name,
      id: "harness-123",
      target,
      credentialProvider: credentials,
    });
    const deployed = { harnessId: "harness-123" } as Harness;
    core.harness.setGetResponse({ harness: deployed });
    const aws = createHarnessDevAws(core, project(), "staging", "us-west-2");

    expect(await aws.deployedHarness("h1")).toBe(deployed);
    expect(core.harness.calls).toEqual([
      { method: "getHarness", args: ["harness-123", { region: "eu-west-1", credentials }] },
    ]);

    core.projectManager.resolveDeployedResource = async () => {
      throw new ProjectStateError("not deployed");
    };
    expect(await aws.deployedHarness("h1")).toBeUndefined();
  });

  test.each([
    [target, "eu-west-1"],
    [undefined, "us-west-2"],
  ])("the workload identity lives in the target region (%#)", async (resolved, region) => {
    const core = new TestCoreClient();
    core.projectManager.resolveTarget = async () => resolved;
    const aws = createHarnessDevAws(core, project(), "staging", "us-west-2");

    expect(await aws.workloadAccessToken()).toEqual({ token: "test-workload-token" });
    expect(core.identity.calls.map(({ args }) => args)).toEqual([
      ["agentcore-dev-test-project-staging", { region }],
      ["agentcore-dev-test-project-staging", { region }],
    ]);
  });

  test("ensures the identity once, and a failed token call ensures again and retries once", async () => {
    const core = new TestCoreClient();
    core.projectManager.resolveTarget = async () => undefined;
    let failures = 1;
    const getToken = core.identity.getWorkloadAccessToken.bind(core.identity);
    core.identity.getWorkloadAccessToken = async (name, options) => {
      if (failures-- > 0) throw new Error("AccessDenied");
      return getToken(name, options);
    };
    core.identity.ensureWorkloadIdentity = async (name, options) => {
      core.identity.calls.push({ method: "ensureWorkloadIdentity", args: [name, options] });
      return { created: true };
    };
    const aws = createHarnessDevAws(core, project(), "staging", "us-west-2");

    expect(await aws.workloadAccessToken()).toEqual({
      token: "test-workload-token",
      createdIdentity: "agentcore-dev-test-project-staging",
    });
    expect(await aws.workloadAccessToken()).toEqual({
      token: "test-workload-token",
      createdIdentity: undefined,
    });
    expect(core.identity.calls.map(({ method }) => method)).toEqual([
      "ensureWorkloadIdentity",
      "ensureWorkloadIdentity",
      "getWorkloadAccessToken",
      "getWorkloadAccessToken",
    ]);
  });

  test("a failed identity call names the identity", async () => {
    const core = new TestCoreClient();
    core.projectManager.resolveTarget = async () => undefined;
    core.identity.setError(new Error("AccessDenied"));

    await expect(
      createHarnessDevAws(core, project(), "staging", "us-west-2").workloadAccessToken(),
    ).rejects.toThrow(
      "Workload identity 'agentcore-dev-test-project-staging' call failed: AccessDenied",
    );
  });
});
