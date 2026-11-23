/**
 * The gateways of the project that a boxed agent calls through its runtime's Box gateway. A runtime
 * without a box gets each gateway without `boundRuntime` in `AGENTCORE_GATEWAY_<NAME>_URL`. On
 * AgentCore Runtime, the boxed agent gets the same variable, and box sends each call to the
 * gateway's host to a Box gateway target that names that gateway (`passthrough.gateway`).
 */
import { createHash } from "node:crypto";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import { gatewayDiscoveryPrefix, type ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { PassthroughGatewayCheck } from "../backends/cdk/compatibility";
import { BOX_EGRESS_TARGET_PREFIX, targetNameFor } from "./egress";

/** A gateway of the project that a boxed runtime calls through its Box gateway. */
export interface BoxProjectGateway {
  /** The gateway's name in agentcore.json, and the name of its `[mcp]` server on the Runtime. */
  readonly name: string;
  /** The target of the Box gateway that calls it. */
  readonly target: string;
  /** The prefix of the variables the CDK library sets for it: `<prefix>_URL` and `<prefix>_HOST`. */
  readonly variablePrefix: string;
  /** How the Box gateway authenticates to it: with its role for `AWS_IAM`, with nothing for `NONE`. */
  readonly auth: "iam" | "none";
}

/** The start of the name of each Box gateway target that calls a gateway of the project. */
const PROJECT_GATEWAY_TARGET_PREFIX = "gateway-";

/** The longest name of a gateway target, as AgentCore takes it. */
const MAX_TARGET_NAME = 100;

/**
 * The Box gateway target name for the gateway `name`: `egress-gateway-<name>` when that name keeps
 * `name` whole. When {@link targetNameFor} changes it, as for `a--b` or a name that is too long,
 * the name ends in 8 hex digits of the SHA-256 of `name`, so two gateways never share a target.
 */
function projectGatewayTargetName(name: string): string {
  const plain = `${BOX_EGRESS_TARGET_PREFIX}${PROJECT_GATEWAY_TARGET_PREFIX}${name}`;
  if (targetNameFor(`${PROJECT_GATEWAY_TARGET_PREFIX}${name}`) === plain) return plain;
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const room = MAX_TARGET_NAME - BOX_EGRESS_TARGET_PREFIX.length - suffix.length - 1;
  const kept = targetNameFor(`${PROJECT_GATEWAY_TARGET_PREFIX}${name}`)!
    .slice(BOX_EGRESS_TARGET_PREFIX.length)
    .slice(0, room)
    .replace(/-+$/, "");
  return `${BOX_EGRESS_TARGET_PREFIX}${kept}-${suffix}`;
}

/**
 * The gateways of `spec` that `runtime` calls through its Box gateway: each gateway without
 * `boundRuntime`, as the CDK library binds it to a runtime without a box. A `PRIVATE_VPC` runtime
 * gets none, and no `CUSTOM_JWT` gateway, because the Box gateway cannot get its token;
 * `add gateway` or `add runtime` gives {@link customJwtGatewayNotice} for it once. When `check`
 * does not accept `passthrough.gateway`, the runtime gets none, and one warning names them and says
 * why.
 */
export function projectGatewaysOf(
  spec: ProjectSpec,
  runtime: Pick<ProjectRuntime, "name" | "containment">,
  check: PassthroughGatewayCheck = { accepts: true },
): { gateways: BoxProjectGateway[]; warnings: string[] } {
  const gateways: BoxProjectGateway[] = [];
  const warnings: string[] = [];
  if (runtime.containment === "PRIVATE_VPC") return { gateways, warnings };
  for (const gateway of spec.agentCoreGateways) {
    if (gateway.boundRuntime !== undefined) continue;
    if (gateway.authorizerType === "CUSTOM_JWT") continue;
    gateways.push({
      name: gateway.name,
      target: projectGatewayTargetName(gateway.name),
      variablePrefix: gatewayDiscoveryPrefix(gateway),
      auth: gateway.authorizerType === "AWS_IAM" ? "iam" : "none",
    });
  }
  if (!check.accepts && gateways.length > 0) {
    warnings.push(
      `The gateways ${gatewayList(gateways.map(({ name }) => name))} of this project get no ` +
        `route for a boxed agent on AgentCore Runtime, because ${uncheckedBecause(check)}`,
    );
    return { gateways: [], warnings };
  }
  return { gateways, warnings };
}

/**
 * The Box gateway target that calls `gateway`, signed for AgentCore for an `AWS_IAM` gateway. The
 * CDK library sets its endpoint, signs in the region of the stack, where the gateway is, and grants
 * the Box gateway's role `InvokeGateway`. Thus the target has no region.
 */
export function projectGatewayTargetFor(gateway: BoxProjectGateway): AgentCoreGatewayTarget {
  return {
    name: gateway.target,
    targetType: "passthrough",
    passthrough: { gateway: gateway.name, protocolType: "CUSTOM" },
    ...(gateway.auth === "iam" && {
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore" },
    }),
  };
}

/** Why build writes no gateway target, from the check of the CDK library, and how to fix it. */
export function uncheckedBecause(
  check: Extract<PassthroughGatewayCheck, { accepts: false }>,
): string {
  const library = "the @aws/agentcore-cdk in agentcore/cdk";
  switch (check.reason) {
    case "refuses":
      return (
        `${library} does not accept passthrough.gateway. Update @aws/agentcore-cdk in ` +
        "agentcore/cdk/package.json to a version that accepts it, then build again."
      );
    case "not-installed":
      return (
        "build found no @aws/agentcore-cdk in agentcore/cdk. Run npm install in agentcore/cdk, " +
        "then build again."
      );
    case "no-node":
      return `build cannot run node to check ${library}. Put node on PATH, then build again.`;
    case "timed-out":
      return `the check of ${library} took more than 60 seconds. Build again.`;
    case "failed":
      return `the check of ${library} failed: ${check.detail ?? "no error message"}. Build again.`;
  }
}

/**
 * The names of the gateways of `spec` that a boxed runtime of `runtimes` calls through its Box
 * gateway, each one time: the gateways that need the check of the CDK library.
 */
export function reachedGatewayNames(
  spec: ProjectSpec,
  runtimes: readonly Pick<ProjectRuntime, "name" | "containment">[],
): string[] {
  const names = runtimes.flatMap((runtime) =>
    projectGatewaysOf(spec, runtime).gateways.map(({ name }) => name),
  );
  return [...new Set(names)];
}

/** The quoted names of `names`, as a list in a sentence: `'a', 'b' and 'c'`. */
export function gatewayList(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0]!;
}

/** What `add gateway` or `add runtime` tells the user once about a `CUSTOM_JWT` gateway in a Box project. */
export function customJwtGatewayNotice(gatewayName: string): string {
  return (
    `the gateway '${gatewayName}' takes CUSTOM_JWT tokens, and a Box gateway signs only with its ` +
    `IAM role, so a boxed agent cannot call '${gatewayName}' on AgentCore Runtime, and build adds ` +
    "no route to it. Set its authorizerType to AWS_IAM to let a boxed agent call it"
  );
}

/** The `@box/agentcore` inputs that carry the URL and the host of `gateway` on the Runtime. */
export function projectGatewayInputs(gateway: Pick<BoxProjectGateway, "name">): {
  readonly url: string;
  readonly host: string;
} {
  return { url: `gateways.${gateway.name}.url`, host: `gateways.${gateway.name}.host` };
}
