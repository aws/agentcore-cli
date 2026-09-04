import { describe, expect, test } from "bun:test";
import type { IAMClient } from "@aws-sdk/client-iam";
import {
  createIamExecutionRoleProvisioner,
  desiredExecutionPolicy,
  ensureDefaultExecutionRole,
  executionRoleName,
  EXECUTION_POLICY_NAME,
} from "./executionRole";

const ROLE_ARN = "arn:aws:iam::111122223333:role/AgentCoreHarness-support";

type Sent = { name: string; input: Record<string, unknown> };

/**
 * A fake IAM at the `.send()` seam: a role store plus a call log, throwing the
 * SDK's NoSuchEntityException by name so the code under test sees what the
 * real client would.
 */
function fakeIam(initial: { role?: boolean; policy?: string } = {}) {
  const sent: Sent[] = [];
  let role = initial.role ? { RoleName: "AgentCoreHarness-support", Arn: ROLE_ARN } : undefined;
  let policy = initial.policy;
  const noSuchEntity = () => {
    const error = new Error("not found");
    error.name = "NoSuchEntityException";
    return error;
  };
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      switch (command.constructor.name) {
        case "GetRoleCommand":
          if (!role) throw noSuchEntity();
          return { Role: role };
        case "CreateRoleCommand":
          role = { RoleName: command.input.RoleName as string, Arn: ROLE_ARN };
          return { Role: role };
        case "GetRolePolicyCommand":
          if (!policy) throw noSuchEntity();
          // IAM hands inline documents back URL-encoded.
          return { PolicyDocument: encodeURIComponent(policy) };
        case "PutRolePolicyCommand":
          policy = command.input.PolicyDocument as string;
          return {};
        default:
          throw new Error(`unexpected IAM call ${command.constructor.name}`);
      }
    },
  };
  return { client: client as unknown as IAMClient, sent, policy: () => policy };
}

describe("executionRoleName", () => {
  test("prefixes the harness name and caps at IAM's 64 characters", () => {
    expect(executionRoleName("support")).toBe("AgentCoreHarness-support");
    expect(executionRoleName("x".repeat(80))).toHaveLength(64);
  });
});

describe("desiredExecutionPolicy", () => {
  test("scopes the document to the region, account, and harness", () => {
    const policy = desiredExecutionPolicy("us-east-1", "111122223333", "support");
    const statements = policy.Statement as { Sid: string; Resource: unknown }[];
    expect(policy.Version).toBe("2012-10-17");
    const identity = statements.find((s) => s.Sid === "AgentCoreWorkloadIdentity")!;
    expect(identity.Resource).toContain(
      "arn:aws:bedrock-agentcore:us-east-1:111122223333:workload-identity-directory/default/workload-identity/support-*",
    );
    const memory = statements.find((s) => s.Sid === "AgentCoreMemory")!;
    expect(memory.Resource).toBe(
      "arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/harness_*",
    );
  });
});

describe("ensureDefaultExecutionRole", () => {
  test("creates a missing role and attaches the policy", async () => {
    const iam = fakeIam();

    const arn = await ensureDefaultExecutionRole(iam.client, "support", "us-east-1");

    expect(arn).toBe(ROLE_ARN);
    expect(iam.sent.map((s) => s.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "PutRolePolicyCommand",
    ]);
    expect(JSON.parse(iam.policy()!)).toEqual(
      desiredExecutionPolicy("us-east-1", "111122223333", "support"),
    );
  });

  test("reuses an existing role and refreshes its policy", async () => {
    const iam = fakeIam({ role: true, policy: "{}" });

    const arn = await ensureDefaultExecutionRole(iam.client, "support", "us-east-1");

    expect(arn).toBe(ROLE_ARN);
    expect(iam.sent.map((s) => s.name)).toEqual(["GetRoleCommand", "PutRolePolicyCommand"]);
    expect(iam.sent[1]?.input).toMatchObject({
      RoleName: "AgentCoreHarness-support",
      PolicyName: EXECUTION_POLICY_NAME,
    });
  });

  test("rethrows IAM errors other than a missing role", async () => {
    const iam = fakeIam();
    iam.client.send = (async () => {
      throw new Error("AccessDenied");
    }) as never;
    await expect(ensureDefaultExecutionRole(iam.client, "support", "us-east-1")).rejects.toThrow(
      "AccessDenied",
    );
  });
});

describe("createIamExecutionRoleProvisioner", () => {
  test("describe reports an absent role as undefined", async () => {
    const iam = fakeIam();
    const provisioner = createIamExecutionRoleProvisioner(() => iam.client);

    expect(await provisioner.describe("support", "us-east-1")).toBeUndefined();
    expect(iam.sent.map((s) => s.name)).toEqual(["GetRoleCommand"]);
  });

  test("describe reports a role without the inline policy", async () => {
    const iam = fakeIam({ role: true });
    const provisioner = createIamExecutionRoleProvisioner(() => iam.client);

    expect(await provisioner.describe("support", "us-east-1")).toEqual({ roleArn: ROLE_ARN });
    expect(iam.sent[1]?.input).toEqual({
      RoleName: "AgentCoreHarness-support",
      PolicyName: EXECUTION_POLICY_NAME,
    });
  });

  test("describe decodes the attached policy document", async () => {
    const document = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "A B" }] });
    const iam = fakeIam({ role: true, policy: document });
    const provisioner = createIamExecutionRoleProvisioner(() => iam.client);

    expect(await provisioner.describe("support", "us-east-1")).toEqual({
      roleArn: ROLE_ARN,
      policyDocument: document,
    });
  });

  test("ensure provisions through ensureDefaultExecutionRole with the region's client", async () => {
    const regions: string[] = [];
    const iam = fakeIam();
    const provisioner = createIamExecutionRoleProvisioner((region) => {
      regions.push(region);
      return iam.client;
    });

    expect(await provisioner.ensure("support", "eu-west-1")).toBe(ROLE_ARN);
    expect(regions).toEqual(["eu-west-1"]);
    expect(iam.sent.map((s) => s.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "PutRolePolicyCommand",
    ]);
    expect(iam.policy()).toContain("arn:aws:logs:eu-west-1:111122223333");
  });

  test("describe rethrows IAM errors other than a missing entity", async () => {
    const iam = fakeIam();
    iam.client.send = (async () => {
      throw new Error("Throttling");
    }) as never;
    const provisioner = createIamExecutionRoleProvisioner(() => iam.client);
    await expect(provisioner.describe("support", "us-east-1")).rejects.toThrow("Throttling");
  });
});
