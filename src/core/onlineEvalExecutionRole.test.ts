import { test, expect } from "bun:test";
import {
  executionPolicy,
  isManagedOnlineEvalRole,
  onlineEvalExecutionRoleName,
  scopePolicyName,
} from "./onlineEvalExecutionRole";

const REGION = "us-west-2";
const ACCOUNT = "123456789012";
const LOG_GROUPS = ["/aws/bedrock-agentcore/runtimes/orders-agent-abc123-DEFAULT"];

function statements(policy: string): { Sid?: string; Action?: unknown; Resource?: unknown }[] {
  return JSON.parse(policy).Statement;
}

// The service validates at create time that the role can decrypt any evaluator
// encrypted with a customer managed key, so the statement has to be present and
// scoped to exactly those keys.
test("grants kms:Decrypt scoped to the referenced evaluator keys", () => {
  const keys = [
    "arn:aws:kms:us-west-2:123456789012:key/aaaaaaaa-1111",
    "arn:aws:kms:us-west-2:123456789012:key/bbbbbbbb-2222",
  ];
  const decrypt = statements(executionPolicy(REGION, ACCOUNT, LOG_GROUPS, keys)).find(
    (s) => s.Sid === "DecryptEvaluatorKeys",
  );

  expect(decrypt).toBeDefined();
  expect(decrypt?.Action).toEqual(["kms:Decrypt", "kms:DescribeKey"]);
  expect(decrypt?.Resource).toEqual(keys);
});

// No wildcard when nothing is encrypted: the builtin evaluators carry no key, so
// the common case must not widen the role.
test("omits the KMS statement when no evaluator is encrypted", () => {
  const sids = statements(executionPolicy(REGION, ACCOUNT, LOG_GROUPS, [])).map((s) => s.Sid);
  expect(sids).not.toContain("DecryptEvaluatorKeys");
});

// Query access is scoped to the runtime prefix, not one endpoint's log group: the
// service validates at the runtime level and rejects a narrower policy.
test("scopes trace queries to the runtime prefix and aws/spans", () => {
  const query = statements(executionPolicy(REGION, ACCOUNT, LOG_GROUPS, [])).find(
    (s) => s.Sid === "QuerySampledTraces",
  );
  expect(query?.Resource).toEqual([
    `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:aws/spans*`,
    `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/orders-agent-abc123*`,
  ]);
});

// IAM caps role names at 64 chars. Truncating alone would let two configs share a
// role, and provisioning is idempotent by name, so the second create would
// re-scope the first's policy.
test("keeps role names within 64 characters and distinct", () => {
  const a = onlineEvalExecutionRoleName("x".repeat(44) + "AAAA");
  const b = onlineEvalExecutionRoleName("x".repeat(44) + "BBBB");
  expect(a.length).toBeLessThanOrEqual(64);
  expect(b.length).toBeLessThanOrEqual(64);
  expect(a).not.toBe(b);
  expect(onlineEvalExecutionRoleName("short")).toBe("AgentCoreOnlineEval-short");
});

// A role created by an earlier build carries a hash suffix this build cannot
// recompute, so a truncated name is recognised on its prefix.
test.each([
  ["short", "arn:aws:iam::123456789012:role/AgentCoreOnlineEval-short", true],
  ["short", "arn:aws:iam::123456789012:role/AgentCoreOnlineEval-other", false],
  ["short", "arn:aws:iam::123456789012:role/custom-role", false],
  [
    "x".repeat(50),
    `arn:aws:iam::123456789012:role/${onlineEvalExecutionRoleName("x".repeat(50))}`,
    true,
  ],
  [
    "x".repeat(50),
    `arn:aws:iam::123456789012:role/AgentCoreOnlineEval-${"x".repeat(35)}-20487c61`,
    true,
  ],
  [
    "x".repeat(50),
    `arn:aws:iam::123456789012:role/AgentCoreOnlineEval-${"y".repeat(35)}-20487c61`,
    false,
  ],
])("recognises the managed role for %s from %s: %s", (configName, roleArn, expected) => {
  expect(isManagedOnlineEvalRole(roleArn, configName)).toBe(expected);
});

// Each scope must map to its own policy name. Granting a new scope writes a new
// policy rather than overwriting the current one, which is what lets an update
// keep the old scope intact until the config change has landed.
test("gives policies with different contents different names", () => {
  const orders = scopePolicyName(executionPolicy(REGION, ACCOUNT, ["/orders*"], []));
  const checkout = scopePolicyName(executionPolicy(REGION, ACCOUNT, ["/checkout*"], []));
  expect(orders).not.toBe(checkout);
});

// The name is a fingerprint of the scope, so re-granting an unchanged scope is a
// no-op rewrite of the same policy rather than an accumulating new one — and the
// update path can compare names to know whether anything needs revoking.
test("gives identical policies the same name", () => {
  const keys = ["arn:aws:kms:us-west-2:123456789012:key/aaaa"];
  const doc = executionPolicy(REGION, ACCOUNT, ["/a*", "/b*"], keys);
  expect(scopePolicyName(doc)).toBe(
    scopePolicyName(executionPolicy(REGION, ACCOUNT, ["/a*", "/b*"], keys)),
  );
  // A differing KMS key renders a different document, hence a different name.
  expect(scopePolicyName(doc)).not.toBe(
    scopePolicyName(executionPolicy(REGION, ACCOUNT, ["/a*", "/b*"], [])),
  );
});
