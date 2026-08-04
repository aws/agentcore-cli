import { expect, test } from "bun:test";
import {
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { candidateInlinePolicyName, swapInlinePolicyForOperation } from "./inlinePolicySwap";

const ROLE_NAME = "AgentCoreHarness-orders";
const POLICY_PREFIX = "AgentCoreHarnessExecutionPolicy";
const POLICY_DOCUMENT = '{"Version":"2012-10-17","Statement":[]}';

type SentCommand = DeleteRolePolicyCommand | ListRolePoliciesCommand | PutRolePolicyCommand;

function iamClient(send: (command: SentCommand) => Promise<Record<string, unknown>>): IAMClient {
  return { send } as unknown as IAMClient;
}

test("stages a complete candidate and removes previous family policies after success", async () => {
  const sent: SentCommand[] = [];
  const oldCandidate = `${POLICY_PREFIX}-${"a".repeat(32)}`;
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return {
        PolicyNames: [POLICY_PREFIX, oldCandidate, "CustomerPolicy"],
        IsTruncated: false,
      };
    }
    return {};
  });

  const result = await swapInlinePolicyForOperation(
    iam,
    {
      roleName: ROLE_NAME,
      policyNamePrefix: POLICY_PREFIX,
      policyDocument: POLICY_DOCUMENT,
    },
    async () => {
      expect(sent.at(-1)).toBeInstanceOf(PutRolePolicyCommand);
      return "created";
    },
  );

  const candidateName = candidateInlinePolicyName(POLICY_PREFIX, POLICY_DOCUMENT);
  expect(result).toBe("created");
  expect(sent.map((command) => command.constructor.name)).toEqual([
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
    "DeleteRolePolicyCommand",
    "DeleteRolePolicyCommand",
  ]);
  expect((sent[1] as PutRolePolicyCommand).input.PolicyName).toBe(candidateName);
  expect(
    sent
      .filter((command) => command instanceof DeleteRolePolicyCommand)
      .map((command) => command.input.PolicyName),
  ).toEqual([POLICY_PREFIX, oldCandidate]);
});

test("removes a new candidate and preserves previous policies when the operation fails", async () => {
  const sent: SentCommand[] = [];
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [POLICY_PREFIX], IsTruncated: false };
    }
    return {};
  });

  await expect(
    swapInlinePolicyForOperation(
      iam,
      {
        roleName: ROLE_NAME,
        policyNamePrefix: POLICY_PREFIX,
        policyDocument: POLICY_DOCUMENT,
      },
      async () => {
        throw new Error("deployment failed");
      },
    ),
  ).rejects.toThrow("deployment failed");

  expect(
    sent
      .filter((command) => command instanceof DeleteRolePolicyCommand)
      .map((command) => command.input.PolicyName),
  ).toEqual([candidateInlinePolicyName(POLICY_PREFIX, POLICY_DOCUMENT)]);
});

test("keeps a pre-existing candidate when the operation fails", async () => {
  const candidateName = candidateInlinePolicyName(POLICY_PREFIX, POLICY_DOCUMENT);
  const sent: SentCommand[] = [];
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [candidateName], IsTruncated: false };
    }
    return {};
  });

  await expect(
    swapInlinePolicyForOperation(
      iam,
      {
        roleName: ROLE_NAME,
        policyNamePrefix: POLICY_PREFIX,
        policyDocument: POLICY_DOCUMENT,
      },
      async () => {
        throw new Error("deployment failed");
      },
    ),
  ).rejects.toThrow("deployment failed");

  expect(sent.some((command) => command instanceof DeleteRolePolicyCommand)).toBeFalse();
});

test("removes a first candidate when the first operation fails", async () => {
  const sent: SentCommand[] = [];
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [], IsTruncated: false };
    }
    return {};
  });

  await expect(
    swapInlinePolicyForOperation(
      iam,
      {
        roleName: ROLE_NAME,
        policyNamePrefix: POLICY_PREFIX,
        policyDocument: POLICY_DOCUMENT,
      },
      async () => {
        throw new Error("deployment failed");
      },
    ),
  ).rejects.toThrow("deployment failed");

  expect(sent.map((command) => command.constructor.name)).toEqual([
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
    "DeleteRolePolicyCommand",
  ]);
});

test("preserves both operation and rollback failures", async () => {
  const iam = iamClient(async (command) => {
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [POLICY_PREFIX], IsTruncated: false };
    }
    if (command instanceof DeleteRolePolicyCommand) throw new Error("rollback failed");
    return {};
  });

  const error = await swapInlinePolicyForOperation(
    iam,
    {
      roleName: ROLE_NAME,
      policyNamePrefix: POLICY_PREFIX,
      policyDocument: POLICY_DOCUMENT,
    },
    async () => {
      throw new Error("deployment failed");
    },
  ).catch((caught) => caught);

  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((cause) => (cause as Error).message)).toEqual([
    "deployment failed",
    "One or more IAM policies could not be removed",
  ]);
});

test("keeps the candidate when previous-policy cleanup fails after success", async () => {
  const candidateName = candidateInlinePolicyName(POLICY_PREFIX, POLICY_DOCUMENT);
  const sent: SentCommand[] = [];
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [POLICY_PREFIX], IsTruncated: false };
    }
    if (command instanceof DeleteRolePolicyCommand && command.input.PolicyName === POLICY_PREFIX) {
      throw new Error("cleanup failed");
    }
    return {};
  });

  await expect(
    swapInlinePolicyForOperation(
      iam,
      {
        roleName: ROLE_NAME,
        policyNamePrefix: POLICY_PREFIX,
        policyDocument: POLICY_DOCUMENT,
      },
      async () => "created",
    ),
  ).rejects.toThrow("Operation succeeded but previous IAM policies could not be removed");

  expect((sent[1] as PutRolePolicyCommand).input.PolicyName).toBe(candidateName);
  expect(
    sent
      .filter((command) => command instanceof DeleteRolePolicyCommand)
      .map((command) => command.input.PolicyName),
  ).toEqual([POLICY_PREFIX]);
});

test("lists every policy page before staging the candidate", async () => {
  const sent: SentCommand[] = [];
  const iam = iamClient(async (command) => {
    sent.push(command);
    if (command instanceof ListRolePoliciesCommand) {
      return command.input.Marker
        ? { PolicyNames: [`${POLICY_PREFIX}-${"b".repeat(32)}`], IsTruncated: false }
        : { PolicyNames: [POLICY_PREFIX], IsTruncated: true, Marker: "page-2" };
    }
    return {};
  });

  await swapInlinePolicyForOperation(
    iam,
    {
      roleName: ROLE_NAME,
      policyNamePrefix: POLICY_PREFIX,
      policyDocument: POLICY_DOCUMENT,
    },
    async () => "created",
  );

  expect(sent.slice(0, 3).map((command) => command.constructor.name)).toEqual([
    "ListRolePoliciesCommand",
    "ListRolePoliciesCommand",
    "PutRolePolicyCommand",
  ]);
});
