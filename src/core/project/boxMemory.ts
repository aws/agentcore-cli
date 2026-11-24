import { isDeepStrictEqual } from "node:util";
import { partition } from "@aws-sdk/util-endpoints";
import {
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
  DEFAULT_EGRESS_BEDROCK_REGION,
  callsBedrockModel,
  getBoxGatewayBedrockTargetSpec,
} from "../../handlers/project/shortcuts";
import type { AgentCoreGateway, AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import { isBoundGateway, type ProjectSpec } from "../../projectSchemas/project";
import { defaultMemoryName } from "../../projectSchemas/memory";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BOX_EGRESS_TARGET_PREFIX } from "./boxNetwork/egress";
import { runtimeRunsInBox } from "./templates/boxProfile";

/**
 * The policy file, relative to the project root, that lets the Box gateway's role call the Bedrock
 * model for the boxed agents: the gateway's `bedrock` target signs the model calls with that role,
 * not the execution role. The CLI rewrites it on build.
 */
export const BOX_BEDROCK_POLICY_FILE = "agentcore/box-bedrock-policy.json";

/**
 * The name of the Runtime profile route of the agent's Memory calls, which go to Memory directly
 * (runtimeProfile/rules/additions.ts).
 */
export const BOX_MEMORY_ROUTE_NAME = "agentcore";

/** The Bedrock actions behind Converse and ConverseStream, which the agent's model calls make. */
const BEDROCK_INVOKE_ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];

/** The IAM policy variable for the account of the gateway role. */
const PRINCIPAL_ACCOUNT = "${aws:PrincipalAccount}";

/** Whether the project has the default Memory create scaffolds for `runtime`. */
export function hasDefaultMemory(spec: ProjectSpec, runtime: ProjectRuntime): boolean {
  return spec.memories.some((memory) => memory.name === defaultMemoryName(runtime.name));
}

/**
 * The runtimes of a Box project that run their agent in a box. Only a Box project has the Box
 * gateways their calls go through.
 */
function boxedRuntimes(spec: ProjectSpec): ProjectRuntime[] {
  return spec.runtimes.filter((runtime) => runtimeRunsInBox(spec, runtime));
}

/**
 * Whether a runtime's agent calls a Bedrock model, as its box profile routes it: a protocol other
 * than MCP, and the Bedrock provider (the default) or a `bedrock/` LiteLLM model.
 */
function callsBedrock(runtime: ProjectRuntime): boolean {
  return (
    runtime.protocol !== "MCP" &&
    callsBedrockModel({ modelProvider: runtime.modelProvider, modelId: runtime.modelId })
  );
}

/** The runtimes of a Box project that run their agent in a box and call a Bedrock model. */
function boxedRuntimesCallingBedrock(spec: ProjectSpec): ProjectRuntime[] {
  return boxedRuntimes(spec).filter(callsBedrock);
}

/**
 * The IAM policy document for {@link BOX_BEDROCK_POLICY_FILE}, or undefined when no boxed runtime
 * calls a Bedrock model. Each ARN is in the partition of `region`, the region of the `bedrock`
 * target that build writes. One file serves every deploy target, so the inference profile ARN
 * names no account, and the condition holds the profile to the gateway role's own account. A
 * cross-region (`us.`, `global.`) inference profile invokes the model in other regions, so a
 * foundation model outside `region` matches only through an inference profile of that account in
 * `region`.
 */
export function boxBedrockPolicy(
  spec: ProjectSpec,
  region: string,
): Record<string, unknown> | undefined {
  if (boxedRuntimesCallingBedrock(spec).length === 0) return undefined;
  const bedrock = `arn:${partition(region).name}:bedrock`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BoxedAgentInferenceProfilesThroughGateway",
        Effect: "Allow",
        Action: BEDROCK_INVOKE_ACTIONS,
        Resource: [`${bedrock}:${region}:*:inference-profile/*`],
        Condition: { StringEquals: { "aws:ResourceAccount": PRINCIPAL_ACCOUNT } },
      },
      {
        Sid: "BoxedAgentModelsInRegionThroughGateway",
        Effect: "Allow",
        Action: BEDROCK_INVOKE_ACTIONS,
        Resource: [`${bedrock}:${region}::foundation-model/*`],
      },
      {
        Sid: "BoxedAgentModelsThroughInferenceProfiles",
        Effect: "Allow",
        Action: BEDROCK_INVOKE_ACTIONS,
        Resource: [`${bedrock}:*::foundation-model/*`],
        Condition: {
          StringLike: {
            "bedrock:InferenceProfileArn": `${bedrock}:${region}:${PRINCIPAL_ACCOUNT}:inference-profile/*`,
          },
        },
      },
    ],
  };
}

/**
 * The names that build owns on a Box gateway: the `bedrock` target of the agent's model calls, and
 * the name of the agent's Memory route. A target of that name would give the Runtime profile a
 * route that takes the Memory route's name.
 */
const BOX_DEFAULT_TARGET_NAMES: readonly string[] = [
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
  BOX_MEMORY_ROUTE_NAME,
];

/**
 * The refusal of a user target named `name` on `gateway`, or `undefined` when build does not own
 * the name there. On the Box gateway of a runtime that runs in a box, build writes the `bedrock`
 * target, owns the `agentcore` name for the Memory route, and names each egress target it writes
 * with the `egress-` prefix. A
 * user target of such a name would take the agent's Bedrock route, the name of its direct Memory
 * route, or the name of an egress target that build writes. Build writes none of these for another runtime.
 */
export function reservedBoxTargetNameProblem(
  spec: ProjectSpec,
  gateway: AgentCoreGateway,
  name: string,
): string | undefined {
  const boxed = boxedRuntimes(spec).some((runtime) => runtime.name === gateway.boundRuntime);
  if (!isBoundGateway(gateway) || !boxed) return undefined;
  if (!BOX_DEFAULT_TARGET_NAMES.includes(name) && !name.startsWith(BOX_EGRESS_TARGET_PREFIX)) {
    return undefined;
  }
  const reserved = [
    ...BOX_DEFAULT_TARGET_NAMES.map((n) => `'${n}'`),
    `'${BOX_EGRESS_TARGET_PREFIX}*'`,
  ];
  return (
    `the gateway target name '${name}' is reserved on Box gateway '${gateway.name}': build owns the ` +
    `names ${reserved.join(", ")} for the agent's model calls, Memory route, and egress targets. Choose another name.`
  );
}

/**
 * Lists `policyFile` in `gateway`'s `additionalPolicies`, unless the gateway imports its role
 * (`executionRoleArn`), which is the user's to grant; the L3 warns about it at synth.
 */
function grantPolicyFile(
  gateway: AgentCoreGateway,
  policyFile: string,
  messages: string[],
  calls: string,
): void {
  if (gateway.executionRoleArn || gateway.additionalPolicies?.includes(policyFile)) return;
  gateway.additionalPolicies = [...(gateway.additionalPolicies ?? []), policyFile];
  messages.push(
    `adding '${policyFile}' to gateway '${gateway.name}' additionalPolicies in agentcore.json, ` +
      `so its role can call ${calls}`,
  );
}

/**
 * Adds the `bedrock` passthrough target, in `region`, to the Box gateway of each runtime that runs
 * its agent in a box and calls a Bedrock model, so the Runtime profile has a route for the model
 * calls: the profile has a route for each target of the Box gateway, and no other. Lists
 * {@link BOX_BEDROCK_POLICY_FILE} in that gateway's `additionalPolicies`, since the target signs
 * the model calls with the gateway's role. Changes nothing outside a Box project. Changes `spec`
 * in place, and returns the step messages; none when nothing changed.
 */
export function addBoxBedrockTarget(
  spec: ProjectSpec,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
): string[] {
  const messages: string[] = [];
  for (const runtime of boxedRuntimesCallingBedrock(spec)) {
    const gateway = boxGatewayFor(spec, runtime);
    if (!gateway) continue;
    placeTarget(gateway, getBoxGatewayBedrockTargetSpec, region, messages, "model calls");
    grantPolicyFile(gateway, BOX_BEDROCK_POLICY_FILE, messages, "the Bedrock model");
  }
  return messages;
}

/**
 * Adds the Box gateway targets that the boxed agents' calls need, in `region`, before build renders
 * the Runtime profiles from those targets: the Bedrock model's. The agent's Memory calls take no
 * target: box signs them with the execution role and sends them to Memory itself, so Memory can
 * hold each call to the session of the runtime (runtimeProfile/rules/additions.ts).
 */
export function addBoxGatewayTargets(
  spec: ProjectSpec,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
): string[] {
  return addBoxBedrockTarget(spec, region);
}

/**
 * The Box gateway of `runtime`: the gateway bound to it. ProjectSpecSchema requires a Box project
 * to keep one for each runtime.
 */
function boxGatewayFor(spec: ProjectSpec, runtime: ProjectRuntime): AgentCoreGateway | undefined {
  return spec.agentCoreGateways.find(({ boundRuntime }) => boundRuntime === runtime.name);
}

/**
 * Whether `targets` has `wanted`: a target of its name, or one for its endpoint, which then takes
 * its calls, so one endpoint has one target.
 */
function servesTarget(targets: readonly AgentCoreGatewayTarget[], wanted: AgentCoreGatewayTarget) {
  const endpoint = (target: AgentCoreGatewayTarget) =>
    target.passthrough?.endpoint && new URL(target.passthrough.endpoint).host;
  return targets.some(
    (target) => target.name === wanted.name || endpoint(target) === endpoint(wanted),
  );
}

/**
 * Puts the target `targetFor(region)` on `gateway`: adds it when no target serves its name or
 * endpoint, and moves one that build wrote for another region to `region`. A target of that name
 * that build did not write is the user's, and stays as it is.
 */
function placeTarget(
  gateway: { name: string; targets: AgentCoreGatewayTarget[] },
  targetFor: (region: string) => AgentCoreGatewayTarget,
  region: string,
  messages: string[],
  calls: string,
): void {
  const wanted = targetFor(region);
  const index = gateway.targets.findIndex(({ name }) => name === wanted.name);
  const existing = index === -1 ? undefined : gateway.targets[index]!;
  const writtenRegion = existing?.outboundAuth?.region;
  if (existing && writtenRegion && writtenRegion !== region) {
    if (isDeepStrictEqual(existing, targetFor(writtenRegion))) {
      gateway.targets[index] = wanted;
      messages.push(
        `updating target '${wanted.name}' of gateway '${gateway.name}' in agentcore.json from ` +
          `${writtenRegion} to ${region}`,
      );
    }
    return;
  }
  if (servesTarget(gateway.targets, wanted)) return;
  gateway.targets.push(wanted);
  messages.push(
    `adding target '${wanted.name}' to gateway '${gateway.name}' in agentcore.json, for the ` +
      `boxed agent's ${calls}`,
  );
}
