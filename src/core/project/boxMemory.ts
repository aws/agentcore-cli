import { isDeepStrictEqual } from "node:util";
import { partition } from "@aws-sdk/util-endpoints";
import { InputValidationError } from "../../errors/errors";
import {
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  DEFAULT_EGRESS_BEDROCK_REGION,
  callsBedrockModel,
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
} from "../../handlers/project/shortcuts";
import type { AgentCoreGateway, AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import { isBoundGateway, type ProjectSpec } from "../../projectSchemas/project";
import { defaultMemoryName } from "../../projectSchemas/memory";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { runtimeRunsInBox } from "./templates/boxProfile";

/** The Box gateway's target, and the box route, that the agent's AgentCore Memory calls take. */
export const BOX_MEMORY_TARGET = BOX_GATEWAY_AGENTCORE_TARGET_NAME;

/**
 * The policy file, relative to the project root, that lets the Box gateway's
 * role call AgentCore Memory for the boxed agents. The CLI rewrites it on build.
 */
export const BOX_MEMORY_POLICY_FILE = "agentcore/box-memory-policy.json";

/**
 * The policy file, relative to the project root, that lets the Box gateway's role call the Bedrock
 * model for the boxed agents: the gateway's `bedrock` target signs the model calls with that role,
 * not the execution role. The CLI rewrites it on build.
 */
export const BOX_BEDROCK_POLICY_FILE = "agentcore/box-bedrock-policy.json";

/** The Bedrock actions behind Converse and ConverseStream, which the agent's model calls make. */
const BEDROCK_INVOKE_ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];

/** The IAM policy variable for the account of the gateway role. */
const PRINCIPAL_ACCOUNT = "${aws:PrincipalAccount}";

/** The Memory data-plane actions the agent's session manager calls, as the L3 grants a runtime. */
const MEMORY_DATA_PLANE_ACTIONS = [
  "bedrock-agentcore:ListMemoryRecords",
  "bedrock-agentcore:RetrieveMemoryRecords",
  "bedrock-agentcore:GetEvent",
  "bedrock-agentcore:GetMemory",
  "bedrock-agentcore:GetMemoryRecord",
  "bedrock-agentcore:ListActors",
  "bedrock-agentcore:ListEvents",
  "bedrock-agentcore:ListSessions",
  "bedrock-agentcore:CreateEvent",
  "bedrock-agentcore:DeleteEvent",
  "bedrock-agentcore:DeleteMemoryRecord",
];

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

/** The runtimes of a Box project that run their agent in a box and have their default Memory. */
function boxedRuntimesWithMemory(spec: ProjectSpec): ProjectRuntime[] {
  return boxedRuntimes(spec).filter((runtime) => hasDefaultMemory(spec, runtime));
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
 * The IAM policy document for {@link BOX_MEMORY_POLICY_FILE}, or undefined when
 * no boxed runtime has its default Memory. The Memory ARN is known only after
 * deploy, so each resource matches the physical name the L3 gives the Memory,
 * `<project>_<target>_<memory>-<suffix>`, in any target, in `region`, the region of
 * the `agentcore` target that build writes, and in the partition of `region`. One file
 * serves every deploy target, so the ARN names no account, and the condition holds the
 * Memory to the gateway role's own account.
 */
export function boxMemoryPolicy(
  spec: ProjectSpec,
  region: string,
): Record<string, unknown> | undefined {
  const memories = boxedRuntimesWithMemory(spec).map(({ name }) => defaultMemoryName(name));
  if (memories.length === 0) return undefined;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BoxedAgentMemoryThroughGateway",
        Effect: "Allow",
        Action: MEMORY_DATA_PLANE_ACTIONS,
        Resource: memories.map(
          (memory) =>
            `arn:${partition(region).name}:bedrock-agentcore:${region}:*:memory/${spec.name}_*${memory}-*`,
        ),
        Condition: { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } },
      },
    ],
  };
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
 * Refuses a target named `name` on a gateway that is not a Box gateway: the Box gateways need the
 * name for `calls`.
 */
function refuseTargetNameOutsideBoxGateways(spec: ProjectSpec, name: string, calls: string): void {
  const owner = spec.agentCoreGateways.find(
    (gateway) => !isBoundGateway(gateway) && gateway.targets.some((target) => target.name === name),
  );
  if (owner) {
    throw new InputValidationError(
      `gateway '${owner.name}' has a target named '${name}', the name the Box gateways need for ` +
        `${calls}. Rename that target.`,
    );
  }
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
 * Adds the `agentcore` passthrough target, in `region`, to the Box gateway (the gateway bound to
 * the runtime) of each runtime that runs its agent in a box and has its default Memory, so the box
 * can send the agent's Memory calls through the gateway, and lists {@link BOX_MEMORY_POLICY_FILE}
 * in that gateway's `additionalPolicies` so its role may make them. Changes nothing outside a Box
 * project. Changes `spec` in place, and returns the step messages; none when nothing changed. The
 * target name on a gateway that is not a Box gateway is an error.
 */
export function addBoxMemoryTarget(
  spec: ProjectSpec,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
): string[] {
  const runtimes = boxedRuntimesWithMemory(spec);
  if (runtimes.length === 0) return [];
  refuseTargetNameOutsideBoxGateways(spec, BOX_MEMORY_TARGET, "the agent's Memory calls");

  const messages: string[] = [];
  for (const runtime of runtimes) {
    const gateway = boxGatewayFor(spec, runtime);
    if (!gateway) continue;
    placeTarget(gateway, getBoxGatewayAgentCoreTargetSpec, region, messages, "Memory calls");
    grantPolicyFile(gateway, BOX_MEMORY_POLICY_FILE, messages, "Memory");
  }
  return messages;
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
 * Adds the Box gateway targets that the boxed agents' calls need, the Bedrock model and the default
 * Memory, in `region`, before build renders the Runtime profiles from those targets.
 */
export function addBoxGatewayTargets(
  spec: ProjectSpec,
  region: string = DEFAULT_EGRESS_BEDROCK_REGION,
): string[] {
  return [...addBoxBedrockTarget(spec, region), ...addBoxMemoryTarget(spec, region)];
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
    target.passthrough && new URL(target.passthrough.endpoint).host;
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
