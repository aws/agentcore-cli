import { describe, expect, test } from "bun:test";
import { GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import { ensureDefaultExecutionRole } from "./executionRole";

type Sent = { name: string; input: unknown };

function fakeIam(): { iam: IAMClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const iam = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof GetRoleCommand) {
        return {
          Role: {
            Arn: "arn:aws:iam::123456789012:role/AgentCoreHarness-orders",
          },
        };
      }
      return {};
    },
  } as unknown as IAMClient;
  return { iam, sent };
}

describe("ensureDefaultExecutionRole", () => {
  test("grants access to current and legacy managed-memory names for the harness", async () => {
    const { iam, sent } = fakeIam();

    await ensureDefaultExecutionRole(iam, "orders", "us-west-2");

    const putPolicy = sent.find(({ name }) => name === "PutRolePolicyCommand")!.input as {
      PolicyDocument: string;
    };
    const policy = JSON.parse(putPolicy.PolicyDocument);
    const memory = policy.Statement.find(({ Sid }: { Sid: string }) => Sid === "AgentCoreMemory");

    expect(memory.Resource).toEqual([
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/orders-*",
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/harness_orders_*",
    ]);
  });
});
