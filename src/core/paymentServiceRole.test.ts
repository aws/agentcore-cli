import { expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import {
  ensurePaymentServiceRole,
  paymentServiceRoleName,
  servicePolicy,
  trustPolicy,
} from "./paymentServiceRole";

const REGION = "us-west-2";
const ACCOUNT = "123456789012";

function statements(policy: string): { Sid?: string; Action?: unknown; Resource?: unknown }[] {
  return JSON.parse(policy).Statement;
}

test("prefixes the manager name and stays within IAM's 64-character cap", () => {
  expect(paymentServiceRoleName("Checkout", REGION)).toBe("AgentCorePayments-us-west-2-Checkout");

  const longest = paymentServiceRoleName("a".repeat(48), REGION);
  expect(longest.length).toBe(64);
  expect(longest.startsWith("AgentCorePayments-")).toBe(true);
});

// Truncating alone would let two long names share one role, and provisioning is
// idempotent by name, so the second create would silently reuse the first's.
test("keeps overflowing role names distinct", () => {
  const a = paymentServiceRoleName("x".repeat(44) + "AAAA", REGION);
  const b = paymentServiceRoleName("x".repeat(44) + "BBBB", REGION);
  expect(a.length).toBeLessThanOrEqual(64);
  expect(b.length).toBeLessThanOrEqual(64);
  expect(a).not.toBe(b);
});

test("uses distinct role names for the same manager in different regions", () => {
  for (const name of ["Checkout", "x".repeat(48)]) {
    expect(paymentServiceRoleName(name, "us-east-1")).not.toBe(
      paymentServiceRoleName(name, "us-west-2"),
    );
  }
});

test("long role names work in the Node distribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "payment-role-node-"));
  try {
    await Bun.build({
      entrypoints: [join(import.meta.dir, "paymentServiceRole.ts")],
      target: "node",
      outdir: directory,
      naming: "role.mjs",
    });
    const source = [
      `import { paymentServiceRoleName } from ${JSON.stringify(pathToFileURL(join(directory, "role.mjs")).href)};`,
      `console.log(paymentServiceRoleName("x".repeat(48), "${REGION}"));`,
    ].join("\n");
    const name = execFileSync("node", ["--input-type=module", "--eval", source], {
      encoding: "utf8",
    }).trim();
    expect(name).toHaveLength(64);
    expect(name).toBe(paymentServiceRoleName("x".repeat(48), REGION));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const ownershipTags = (region: string) => [
  { Key: "agentcore:managed-by", Value: "agentcore-cli" },
  { Key: "agentcore:payment-manager", Value: "Checkout" },
  { Key: "agentcore:region", Value: region },
];

test("creates a tagged default role and grants its regional policy", async () => {
  const send = mock(async (command: unknown) => {
    if (command instanceof GetRoleCommand) {
      throw Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
    }
    if (command instanceof CreateRoleCommand) {
      expect(command.input.Tags).toEqual(ownershipTags(REGION));
      expect(command.input.RoleName).toBe("AgentCorePayments-us-west-2-Checkout");
      return { Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/${command.input.RoleName}` } };
    }
    expect(command).toBeInstanceOf(PutRolePolicyCommand);
    return {};
  });
  const arn = await ensurePaymentServiceRole({ send } as unknown as IAMClient, "Checkout", REGION);
  expect(arn).toBe(`arn:aws:iam::${ACCOUNT}:role/AgentCorePayments-us-west-2-Checkout`);
  expect(send).toHaveBeenCalledTimes(3);
});

test("reusing an owned role in another region cannot overwrite the first region's policy", async () => {
  const policies = new Map<string, string>();
  let region = "us-east-1";
  const send = mock(async (command: unknown) => {
    if (command instanceof GetRoleCommand) {
      return {
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT}:role/${command.input.RoleName}`,
          Tags: ownershipTags(region),
        },
      };
    }
    expect(command).toBeInstanceOf(PutRolePolicyCommand);
    const { RoleName, PolicyName, PolicyDocument } = (command as PutRolePolicyCommand).input;
    policies.set(`${RoleName}/${PolicyName}`, PolicyDocument!);
    return {};
  });
  const iam = { send } as unknown as IAMClient;
  await ensurePaymentServiceRole(iam, "Checkout", region);
  region = "us-west-2";
  await ensurePaymentServiceRole(iam, "Checkout", region);
  expect(policies.size).toBe(2);
  expect([...policies.values()]).toEqual([
    servicePolicy("us-east-1", ACCOUNT),
    servicePolicy("us-west-2", ACCOUNT),
  ]);
});

test.each([
  { Tags: undefined },
  { Tags: [] },
  { Tags: [{ Key: "agentcore:managed-by", Value: "another-tool" }] },
  { Tags: ownershipTags("us-east-1") },
  {
    Tags: ownershipTags(REGION).map((tag) =>
      tag.Key === "agentcore:payment-manager" ? { ...tag, Value: "OtherManager" } : tag,
    ),
  },
])("refuses a role without matching ownership tags: %j", async ({ Tags }) => {
  const send = mock(async (command: unknown) => {
    if (command instanceof GetRoleCommand) {
      return {
        Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/default-role`, Tags },
      };
    }
    throw new Error("must not mutate an unrelated role");
  });
  await expect(
    ensurePaymentServiceRole({ send } as unknown as IAMClient, "Checkout", REGION),
  ).rejects.toThrow(/--role-arn/);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a caller's GetRole denial is surfaced without attempting creation", async () => {
  const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  const send = mock(async () => {
    throw error;
  });
  await expect(
    ensurePaymentServiceRole({ send } as unknown as IAMClient, "Checkout", REGION),
  ).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
});

test("trusts the AgentCore service principal", () => {
  const statement = JSON.parse(trustPolicy()).Statement[0];
  expect(statement.Effect).toBe("Allow");
  expect(statement.Principal).toEqual({ Service: "bedrock-agentcore.amazonaws.com" });
  expect(statement.Action).toBe("sts:AssumeRole");
});

// The action list mirrors the ResourceRetrievalRole the L3 CDK construct grants:
// the service assumes this role to mint workload tokens, read the connector's
// credential provider, and fetch payment tokens for every data-plane call.
test("grants the identity, workload token, and payment token actions", () => {
  const identity = statements(servicePolicy(REGION, ACCOUNT)).find(
    (s) => s.Sid === "AgentCoreIdentityAndTokens",
  );
  expect(identity?.Action).toEqual([
    "bedrock-agentcore:RetrieveToken",
    "bedrock-agentcore:GetWorkloadIdentity",
    "bedrock-agentcore:CreateWorkloadIdentity",
    "bedrock-agentcore:GetPaymentCredentialProvider",
    "bedrock-agentcore:TagResource",
    "bedrock-agentcore:GetWorkloadAccessToken",
    "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
    "bedrock-agentcore:GetResourcePaymentToken",
  ]);
  expect(identity?.Resource).toBe("*");
});

// Every AgentCore-managed credential secret lives under the
// `bedrock-agentcore-identity!` prefix, so scoping to it covers the connector
// secrets without exposing unrelated account secrets. Granting the prefix up
// front also means adding a connector never has to mutate the role.
test("scopes secret reads to AgentCore Identity managed secrets in the region and account", () => {
  const secrets = statements(servicePolicy(REGION, ACCOUNT)).find(
    (s) => s.Sid === "IdentityManagedSecrets",
  );
  expect(secrets?.Action).toEqual(["secretsmanager:GetSecretValue"]);
  expect(secrets?.Resource).toBe(
    `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bedrock-agentcore-identity!*`,
  );
});

test("allows sts:SetContext for workload identity tagging", () => {
  const sts = statements(servicePolicy(REGION, ACCOUNT)).find((s) => s.Sid === "StsSetContext");
  expect(sts?.Action).toEqual(["sts:SetContext"]);
  expect(sts?.Resource).toBe("*");
});
