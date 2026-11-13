import { InputValidationError } from "../../errors/errors";
import {
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  BOX_GATEWAY_NAME,
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewaySpec,
} from "../../handlers/project/shortcuts";
import type { ProjectSpec } from "../../projectSchemas/project";
import { defaultMemoryName } from "../../projectSchemas/memory";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { runsBoxStartScript } from "./templates/boxProfile";

/** The Box gateway's target, and the box route, that the agent's AgentCore Memory calls take. */
export const BOX_MEMORY_TARGET = BOX_GATEWAY_AGENTCORE_TARGET_NAME;

/**
 * The policy file, relative to the project root, that lets the Box gateway's
 * role call AgentCore Memory for the boxed agents. The CLI rewrites it on build.
 */
export const BOX_MEMORY_POLICY_FILE = "agentcore/box-memory-policy.json";

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
 * Whether a runtime runs its agent in a box on AgentCore Runtime: a CodeZip
 * runtime whose entry point is the box start script.
 */
function runsAgentInBox(runtime: ProjectRuntime): boolean {
  return runtime.build === "CodeZip" && runsBoxStartScript(runtime.entrypoint);
}

/** The default Memory names of the runtimes that run their agent in a box. */
function boxedDefaultMemories(spec: ProjectSpec): string[] {
  return spec.runtimes
    .filter((runtime) => runsAgentInBox(runtime) && hasDefaultMemory(spec, runtime))
    .map((runtime) => defaultMemoryName(runtime.name));
}

/**
 * The IAM policy document for {@link BOX_MEMORY_POLICY_FILE}, or undefined when
 * no boxed runtime has its default Memory. The Memory ARN is known only after
 * deploy, so each resource matches the physical name the L3 gives the Memory,
 * `<project>_<target>_<memory>-<suffix>`, in any target.
 */
export function boxMemoryPolicy(spec: ProjectSpec): Record<string, unknown> | undefined {
  const memories = boxedDefaultMemories(spec);
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
 * Adds the `agentcore` passthrough target to the Box gateway when a runtime
 * that runs its agent in a box has its default Memory, so the box can send the
 * agent's Memory calls through the gateway, and lists
 * {@link BOX_MEMORY_POLICY_FILE} in the gateway's `additionalPolicies` so its
 * role may make them (unless the gateway imports its role). Recreates the
 * gateway entry when it was removed, and marks the project `"projectType":
 * "box"` so the CDK library deploys the Box gateway that the entry extends.
 * Changes `spec` in place, and returns the step messages; none when nothing
 * changed. Target names are project-unique, so the name on another gateway is
 * an error.
 */
export function addBoxMemoryTarget(spec: ProjectSpec): string[] {
  if (boxedDefaultMemories(spec).length === 0) return [];

  const owner = spec.agentCoreGateways.find((gateway) =>
    gateway.targets.some((target) => target.name === BOX_MEMORY_TARGET),
  );
  if (owner && owner.name !== BOX_GATEWAY_NAME) {
    throw new InputValidationError(
      `gateway '${owner.name}' has a target named '${BOX_MEMORY_TARGET}', the name the ` +
        `'${BOX_GATEWAY_NAME}' gateway needs for the agent's Memory calls. Rename that target.`,
    );
  }

  const messages: string[] = [];
  if (spec.projectType !== "box") {
    spec.projectType = "box";
    messages.push(`setting "projectType": "box" in agentcore.json, for the Box gateway`);
  }
  let gateway = spec.agentCoreGateways.find(({ name }) => name === BOX_GATEWAY_NAME);
  if (!gateway) {
    gateway = getBoxGatewaySpec({ bedrockTarget: false });
    spec.agentCoreGateways.push(gateway);
    messages.push(`adding gateway '${BOX_GATEWAY_NAME}' to agentcore.json`);
  }
  if (!owner) {
    gateway.targets.push(getBoxGatewayAgentCoreTargetSpec());
    messages.push(
      `adding target '${BOX_MEMORY_TARGET}' to gateway '${BOX_GATEWAY_NAME}' in ` +
        "agentcore.json, for the boxed agent's Memory calls",
    );
  }
  // An imported role (executionRoleArn) is the user's to grant; the L3 warns about it at synth.
  if (!gateway.executionRoleArn && !gateway.additionalPolicies?.includes(BOX_MEMORY_POLICY_FILE)) {
    gateway.additionalPolicies = [...(gateway.additionalPolicies ?? []), BOX_MEMORY_POLICY_FILE];
    messages.push(
      `adding '${BOX_MEMORY_POLICY_FILE}' to gateway '${BOX_GATEWAY_NAME}' ` +
        "additionalPolicies in agentcore.json, so its role can call Memory",
    );
  }
  return messages;
}
