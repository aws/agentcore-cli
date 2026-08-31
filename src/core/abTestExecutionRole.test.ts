import { test, expect, describe } from "bun:test";
import { CreateRoleCommand, GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import {
  abTestExecutionRoleName,
  accountIdFromArn,
  provisionAbTestRole,
} from "./abTestExecutionRole";

const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-gw";

type Sent = { name: string; input: unknown };

function fakeIam(onGet: "found" | "missing"): { iam: IAMClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const iam = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof GetRoleCommand) {
        if (onGet === "missing") {
          throw Object.assign(new Error("no such entity"), { name: "NoSuchEntityException" });
        }
        return {
          Role: {
            Arn: `arn:aws:iam::123456789012:role/${(command.input as { RoleName: string }).RoleName}`,
          },
        };
      }
      if (command instanceof CreateRoleCommand) {
        return {
          Role: {
            Arn: `arn:aws:iam::123456789012:role/${(command.input as { RoleName: string }).RoleName}`,
          },
        };
      }
      return {};
    },
  } as unknown as IAMClient;
  return { iam, sent };
}

describe("abTestExecutionRoleName", () => {
  test("stays within IAM's 64-char limit and is deterministic", () => {
    const long = abTestExecutionRoleName("x".repeat(120));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(abTestExecutionRoleName("orders")).toBe(abTestExecutionRoleName("orders"));
  });

  test("distinct names for distinct tests", () => {
    expect(abTestExecutionRoleName("a")).not.toBe(abTestExecutionRoleName("b"));
  });
});

describe("accountIdFromArn", () => {
  test("extracts the account segment", () => {
    expect(accountIdFromArn(GATEWAY_ARN)).toBe("123456789012");
  });
  test("throws on a malformed ARN", () => {
    expect(() => accountIdFromArn("not-an-arn")).toThrow(/account id/);
  });
});

describe("provisionAbTestRole", () => {
  test("creates the role + inline policy and reports created=true", async () => {
    const { iam, sent } = fakeIam("missing");
    const result = await provisionAbTestRole(iam, "orders-v2", GATEWAY_ARN, "us-west-2");

    expect(result.created).toBe(true);
    expect(result.roleArn).toContain(":role/");
    expect(sent.map((s) => s.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "PutRolePolicyCommand",
    ]);

    const create = sent.find((s) => s.name === "CreateRoleCommand")!.input as {
      AssumeRolePolicyDocument: string;
    };
    const trust = JSON.parse(create.AssumeRolePolicyDocument);
    expect(trust.Statement[0].Principal.Service).toBe("bedrock-agentcore.amazonaws.com");
    expect(trust.Statement[0].Condition.StringEquals["aws:SourceAccount"]).toBe("123456789012");
    expect(trust.Statement[0].Condition.ArnLike["aws:SourceArn"]).toContain(":ab-test/*");

    const policy = sent.find((s) => s.name === "PutRolePolicyCommand")!.input as {
      PolicyDocument: string;
    };
    const doc = JSON.parse(policy.PolicyDocument);
    const actions = doc.Statement.flatMap((s: { Action: string[] }) => s.Action);
    expect(actions).toContain("bedrock-agentcore:GetGateway");
    expect(actions).toContain("bedrock-agentcore:GetConfigurationBundleVersion");
    expect(actions).toContain("bedrock-agentcore:GetOnlineEvaluationConfig");
  });

  test("reuses an existing role and reports created=false", async () => {
    const { iam, sent } = fakeIam("found");
    const result = await provisionAbTestRole(iam, "orders-v2", GATEWAY_ARN, "us-west-2");

    expect(result.created).toBe(false);
    expect(sent.map((s) => s.name)).toEqual(["GetRoleCommand", "PutRolePolicyCommand"]);
  });
});
