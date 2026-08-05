import { describe, expect, test } from "bun:test";
import { CreateRoleCommand, GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import { GatewayExecutionRole } from "./gatewayExecutionRole";

const REGION = "us-west-2";
const ACCOUNT_ID = "123456789012";

function noSuchEntity(): Error {
  const error = new Error("not found");
  error.name = "NoSuchEntityException";
  return error;
}

describe("GatewayExecutionRole", () => {
  test("derives deterministic role names within IAM limits", () => {
    const gatewayName = "a".repeat(100);
    const name = GatewayExecutionRole.roleName(gatewayName, REGION);

    expect(name.length).toBeLessThanOrEqual(64);
    expect(GatewayExecutionRole.roleName(gatewayName, REGION)).toBe(name);
    expect(GatewayExecutionRole.roleName(gatewayName, "us-east-1")).not.toBe(name);
  });

  test("creates the default role with AgentCore trust", async () => {
    const commands: unknown[] = [];
    const roleName = GatewayExecutionRole.roleName("orders", REGION);
    const roleArn = `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`;
    const iam = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetRoleCommand) throw noSuchEntity();
        return { Role: { Arn: roleArn } };
      },
    } as unknown as IAMClient;

    await expect(GatewayExecutionRole.ensure(iam, "orders", REGION)).resolves.toBe(roleArn);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(CreateRoleCommand);
    expect((commands[1] as CreateRoleCommand).input).toMatchObject({ RoleName: roleName });
    expect(
      JSON.parse((commands[1] as CreateRoleCommand).input.AssumeRolePolicyDocument!),
    ).toMatchObject({
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "bedrock-agentcore.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });
  });

  test("reuses an existing default role without editing it", async () => {
    const roleName = GatewayExecutionRole.roleName("orders", REGION);
    const roleArn = `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`;
    const commands: unknown[] = [];
    const iam = {
      send: async (command: unknown) => {
        commands.push(command);
        return { Role: { Arn: roleArn } };
      },
    } as unknown as IAMClient;

    await expect(GatewayExecutionRole.ensure(iam, "orders", REGION)).resolves.toBe(roleArn);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetRoleCommand);
  });

  test("retries while the default role is propagating", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await GatewayExecutionRole.retryWhileUnassumable(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("Gateway execution role cannot be assumed");
          error.name = "ValidationException";
          throw error;
        }
        return "created";
      },
      3,
      10,
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(result).toBe("created");
    expect(attempts).toBe(2);
    expect(delays).toEqual([10]);
  });
});
