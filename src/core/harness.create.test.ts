import { expect, test } from "bun:test";
import {
  CreateHarnessCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { HARNESS_EXECUTION_POLICY_NAME } from "./executionRole";
import { HarnessClient } from "./harness";
import { candidateInlinePolicyName } from "./inlinePolicySwap";
import type { AwsClients } from "./types";

const ROLE_NAME = "AgentCoreHarness-orders";
const ROLE_ARN = `arn:aws:iam::123456789012:role/${ROLE_NAME}`;

type SentCommand = { constructor: { name: string }; input: unknown };

function harnessClient(
  controlSend: (command: SentCommand) => Promise<Record<string, unknown>>,
  iamSend: (command: SentCommand) => Promise<Record<string, unknown>>,
): HarnessClient {
  const clients: AwsClients = {
    control: () => ({ send: controlSend }) as unknown as BedrockAgentCoreControlClient,
    data: () => ({}) as BedrockAgentCoreClient,
    iam: () => ({ send: iamSend }) as unknown as IAMClient,
  };
  return new HarnessClient(clients);
}

function role() {
  return {
    Role: {
      Path: "/",
      RoleName: ROLE_NAME,
      RoleId: "AROATEST",
      Arn: ROLE_ARN,
      CreateDate: new Date("2026-08-04T00:00:00Z"),
    },
  };
}

function noSuchEntity(): Error {
  const error = new Error("role not found");
  error.name = "NoSuchEntityException";
  return error;
}

test("creates Harness with a candidate policy and removes the previous policy after success", async () => {
  const sent: SentCommand[] = [];
  let policyDocument = "";
  const client = harnessClient(
    async (command) => {
      sent.push(command);
      if (command instanceof CreateHarnessCommand) {
        return { harness: { harnessId: "harness-1" } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
    async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) return role();
      if (command instanceof ListRolePoliciesCommand) {
        return { PolicyNames: [HARNESS_EXECUTION_POLICY_NAME], IsTruncated: false };
      }
      if (command instanceof PutRolePolicyCommand) {
        policyDocument = command.input.PolicyDocument!;
        return {};
      }
      if (command instanceof DeleteRolePolicyCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  );

  const response = await client.createHarness({ harnessName: "orders" }, { region: "us-west-2" });

  expect(response.harness?.harnessId).toBe("harness-1");
  expect(sent.map((command) => command.constructor.name)).toEqual([
    "GetRoleCommand",
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
    "CreateHarnessCommand",
    "DeleteRolePolicyCommand",
  ]);
  expect((sent[2] as PutRolePolicyCommand).input.PolicyName).toBe(
    candidateInlinePolicyName(HARNESS_EXECUTION_POLICY_NAME, policyDocument),
  );
  expect((sent[3] as CreateHarnessCommand).input.executionRoleArn).toBe(ROLE_ARN);
  expect((sent[4] as DeleteRolePolicyCommand).input.PolicyName).toBe(HARNESS_EXECUTION_POLICY_NAME);
});

test("preserves the previous Harness policy when creation fails", async () => {
  const sent: SentCommand[] = [];
  let candidateName = "";
  const client = harnessClient(
    async (command) => {
      sent.push(command);
      if (command instanceof CreateHarnessCommand) throw new Error("Harness creation failed");
      throw new Error(`unexpected ${command.constructor.name}`);
    },
    async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) return role();
      if (command instanceof ListRolePoliciesCommand) {
        return { PolicyNames: [HARNESS_EXECUTION_POLICY_NAME], IsTruncated: false };
      }
      if (command instanceof PutRolePolicyCommand) {
        candidateName = command.input.PolicyName!;
        return {};
      }
      if (command instanceof DeleteRolePolicyCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  );

  await expect(
    client.createHarness({ harnessName: "orders" }, { region: "us-west-2" }),
  ).rejects.toThrow("Harness creation failed");

  const deletedPolicies = sent
    .filter((command) => command instanceof DeleteRolePolicyCommand)
    .map((command) => (command as DeleteRolePolicyCommand).input.PolicyName);
  expect(deletedPolicies).toEqual([candidateName]);
  expect(deletedPolicies).not.toContain(HARNESS_EXECUTION_POLICY_NAME);
});

test("creates a role and keeps its first candidate after successful Harness creation", async () => {
  const sent: SentCommand[] = [];
  const client = harnessClient(
    async (command) => {
      sent.push(command);
      if (command instanceof CreateHarnessCommand) {
        return { harness: { harnessId: "harness-1" } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
    async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) throw noSuchEntity();
      if (command instanceof CreateRoleCommand) return role();
      if (command instanceof ListRolePoliciesCommand) {
        return { PolicyNames: [], IsTruncated: false };
      }
      if (command instanceof PutRolePolicyCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  );

  const response = await client.createHarness({ harnessName: "orders" }, { region: "us-west-2" });

  expect(response.harness?.harnessId).toBe("harness-1");
  expect(sent.map((command) => command.constructor.name)).toEqual([
    "GetRoleCommand",
    "CreateRoleCommand",
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
    "CreateHarnessCommand",
  ]);
  expect((sent[4] as CreateHarnessCommand).input.executionRoleArn).toBe(ROLE_ARN);
});

test("creates the role and removes its first candidate when Harness creation fails", async () => {
  const sent: SentCommand[] = [];
  const client = harnessClient(
    async (command) => {
      sent.push(command);
      if (command instanceof CreateHarnessCommand) throw new Error("Harness creation failed");
      throw new Error(`unexpected ${command.constructor.name}`);
    },
    async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) throw noSuchEntity();
      if (command instanceof CreateRoleCommand) return role();
      if (command instanceof ListRolePoliciesCommand) {
        return { PolicyNames: [], IsTruncated: false };
      }
      if (command instanceof PutRolePolicyCommand) return {};
      if (command instanceof DeleteRolePolicyCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  );

  await expect(
    client.createHarness({ harnessName: "orders" }, { region: "us-west-2" }),
  ).rejects.toThrow("Harness creation failed");

  expect(sent.map((command) => command.constructor.name)).toEqual([
    "GetRoleCommand",
    "CreateRoleCommand",
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
    "CreateHarnessCommand",
    "DeleteRolePolicyCommand",
  ]);
});

test("does not manage IAM when a Harness execution role is supplied", async () => {
  const sent: SentCommand[] = [];
  const client = harnessClient(
    async (command) => {
      sent.push(command);
      if (command instanceof CreateHarnessCommand) {
        return { harness: { harnessId: "harness-1" } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
    async (command) => {
      sent.push(command);
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  );

  await client.createHarness(
    { harnessName: "orders", executionRoleArn: "arn:aws:iam::123456789012:role/customer" },
    { region: "us-west-2" },
  );

  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(CreateHarnessCommand);
});
