import { InputValidationError } from "../../errors/errors";
import {
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
  callsBedrockModel,
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
  getBoxGatewayEntry,
} from "../../handlers/project/shortcuts";
import { boxGatewayName, type ProjectSpec } from "../../projectSchemas/project";
import { defaultMemoryName } from "../../projectSchemas/memory";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { runsAgentInBox } from "./backends/boxContainer";

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

/** The runtimes that run their agent in a box and have their default Memory. */
function boxedRuntimesWithMemory(spec: ProjectSpec, projectRoot: string): ProjectRuntime[] {
  return spec.runtimes.filter(
    (runtime) => runsAgentInBox(projectRoot, runtime) && hasDefaultMemory(spec, runtime),
  );
}

/**
 * The IAM policy document for {@link BOX_MEMORY_POLICY_FILE}, or undefined when
 * no boxed runtime has its default Memory. The Memory ARN is known only after
 * deploy, so each resource matches the physical name the L3 gives the Memory,
 * `<project>_<target>_<memory>-<suffix>`, in any target.
 */
export function boxMemoryPolicy(
  spec: ProjectSpec,
  projectRoot: string,
): Record<string, unknown> | undefined {
  const memories = boxedRuntimesWithMemory(spec, projectRoot).map((runtime) =>
    defaultMemoryName(runtime.name),
  );
  if (memories.length === 0) return undefined;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BoxedAgentMemoryThroughGateway",
        Effect: "Allow",
        Action: MEMORY_DATA_PLANE_ACTIONS,
        Resource: memories.map(
          (memory) => `arn:aws:bedrock-agentcore:*:*:memory/${spec.name}_*${memory}-*`,
        ),
      },
    ],
  };
}

/**
 * The IAM policy document for {@link BOX_BEDROCK_POLICY_FILE}, or undefined when no boxed runtime
 * calls a Bedrock model. A cross-region (`us.`, `global.`) inference profile invokes the model in
 * other regions, so both the profiles and the foundation models match any region.
 */
export function boxBedrockPolicy(
  spec: ProjectSpec,
  projectRoot: string,
): Record<string, unknown> | undefined {
  if (
    !spec.runtimes.some((runtime) => runsAgentInBox(projectRoot, runtime) && callsBedrock(runtime))
  )
    return undefined;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BoxedAgentModelCallsThroughGateway",
        Effect: "Allow",
        Action: BEDROCK_INVOKE_ACTIONS,
        Resource: [
          "arn:aws:bedrock:*:*:inference-profile/*",
          "arn:aws:bedrock:*::foundation-model/*",
        ],
      },
    ],
  };
}

/**
 * Adds the `agentcore` passthrough target to the Box gateway, `<runtime>-box`, of each runtime
 * that runs its agent in a box and has its default Memory, so the box can send the agent's Memory
 * calls through the gateway, and lists {@link BOX_MEMORY_POLICY_FILE} in that gateway's
 * `additionalPolicies` so its role may make them (unless the gateway imports its role). Recreates
 * a gateway entry that was removed, and marks the project `"projectType": "box"` so the CDK
 * library deploys the Box gateways the entries extend. Changes `spec` in place, and returns the
 * step messages; none when nothing changed. The target name on a gateway that is not a Box
 * gateway is an error.
 */
export function addBoxMemoryTarget(spec: ProjectSpec, projectRoot: string): string[] {
  const runtimes = boxedRuntimesWithMemory(spec, projectRoot);
  if (runtimes.length === 0) return [];

  const boxGateways = new Set(spec.runtimes.map(({ name }) => boxGatewayName(name)));
  const owner = spec.agentCoreGateways.find(
    (gateway) =>
      !boxGateways.has(gateway.name) &&
      gateway.targets.some((target) => target.name === BOX_MEMORY_TARGET),
  );
  if (owner) {
    throw new InputValidationError(
      `gateway '${owner.name}' has a target named '${BOX_MEMORY_TARGET}', the name the Box ` +
        "gateways need for the agent's Memory calls. Rename that target.",
    );
  }

  const messages: string[] = [];
  for (const runtime of runtimes) {
    const gateway = boxGatewayFor(spec, runtime, messages);
    const name = gateway.name;
    if (!gateway.targets.some((target) => target.name === BOX_MEMORY_TARGET)) {
      gateway.targets.push(getBoxGatewayAgentCoreTargetSpec());
      messages.push(
        `adding target '${BOX_MEMORY_TARGET}' to gateway '${name}' in ` +
          "agentcore.json, for the boxed agent's Memory calls",
      );
    }
    // An imported role (executionRoleArn) is the user's to grant; the L3 warns about it at synth.
    if (
      !gateway.executionRoleArn &&
      !gateway.additionalPolicies?.includes(BOX_MEMORY_POLICY_FILE)
    ) {
      gateway.additionalPolicies = [...(gateway.additionalPolicies ?? []), BOX_MEMORY_POLICY_FILE];
      messages.push(
        `adding '${BOX_MEMORY_POLICY_FILE}' to gateway '${name}' ` +
          "additionalPolicies in agentcore.json, so its role can call Memory",
      );
    }
  }
  return messages;
}

/**
 * The Box gateway entry of `runtime`, `<runtime>-box`: recreated when it was removed, with the
 * project marked `"projectType": "box"` so the CDK library deploys the gateway the entry extends.
 * Pushes a step message for each change.
 */
function boxGatewayFor(spec: ProjectSpec, runtime: ProjectRuntime, messages: string[]) {
  if (spec.projectType !== "box") {
    spec.projectType = "box";
    messages.push(`setting "projectType": "box" in agentcore.json, for the Box gateway`);
  }
  const name = boxGatewayName(runtime.name);
  let gateway = spec.agentCoreGateways.find((entry) => entry.name === name);
  if (!gateway) {
    gateway = getBoxGatewayEntry(runtime.name);
    spec.agentCoreGateways.push(gateway);
    messages.push(`adding gateway '${name}' to agentcore.json`);
  }
  return gateway;
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

/**
 * Adds the `bedrock` passthrough target to the Box gateway of each runtime that runs its agent in
 * a box and calls a Bedrock model, when it is missing, so the Runtime profile has a route for the
 * model calls: the profile has a route for each target of the Box gateway, and no other. Create
 * writes the target; this puts it back after it is removed. Lists {@link BOX_BEDROCK_POLICY_FILE}
 * in that gateway's `additionalPolicies`, since the target signs the model calls with the
 * gateway's role (unless the gateway imports its role). Changes `spec` in place, and returns the
 * step messages; none when nothing changed.
 */
export function addBoxBedrockTarget(spec: ProjectSpec, projectRoot: string): string[] {
  const messages: string[] = [];
  for (const runtime of spec.runtimes) {
    if (!runsAgentInBox(projectRoot, runtime) || !callsBedrock(runtime)) continue;
    const gateway = boxGatewayFor(spec, runtime, messages);
    if (!gateway.targets.some(({ name }) => name === BOX_GATEWAY_BEDROCK_TARGET_NAME)) {
      gateway.targets.push(getBoxGatewayBedrockTargetSpec());
      messages.push(
        `adding target '${BOX_GATEWAY_BEDROCK_TARGET_NAME}' to gateway '${gateway.name}' in ` +
          "agentcore.json, for the boxed agent's model calls",
      );
    }
    // An imported role (executionRoleArn) is the user's to grant; the L3 warns about it at synth.
    if (
      !gateway.executionRoleArn &&
      !gateway.additionalPolicies?.includes(BOX_BEDROCK_POLICY_FILE)
    ) {
      gateway.additionalPolicies = [...(gateway.additionalPolicies ?? []), BOX_BEDROCK_POLICY_FILE];
      messages.push(
        `adding '${BOX_BEDROCK_POLICY_FILE}' to gateway '${gateway.name}' ` +
          "additionalPolicies in agentcore.json, so its role can call the Bedrock model",
      );
    }
  }
  return messages;
}

/**
 * Adds the Box gateway targets that the boxed agents' calls need, the Bedrock model and the default
 * Memory, before build renders the Runtime profiles from those targets.
 */
export function addBoxGatewayTargets(spec: ProjectSpec, projectRoot: string): string[] {
  return [...addBoxBedrockTarget(spec, projectRoot), ...addBoxMemoryTarget(spec, projectRoot)];
}
