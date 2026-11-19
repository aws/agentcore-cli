import { InputValidationError } from "../../errors/errors";
import {
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  getBoxGatewayAgentCoreTargetSpec,
} from "../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import { isBoundGateway, isBoxProject, type ProjectSpec } from "../../projectSchemas/project";
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
 * The runtimes of a Box project that run their agent in a box and have their default Memory.
 * Only a Box project has the Box gateways their Memory calls go through.
 */
function boxedRuntimesWithMemory(spec: ProjectSpec, projectRoot: string): ProjectRuntime[] {
  if (!isBoxProject(spec)) return [];
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
  const memories = boxedRuntimesWithMemory(spec, projectRoot).map(({ name }) =>
    defaultMemoryName(name),
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
 * Adds the `agentcore` passthrough target to the Box gateway (the gateway bound to the runtime)
 * of each runtime that runs its agent in a box and has its default Memory, so the box can send
 * the agent's Memory calls through the gateway, and lists {@link BOX_MEMORY_POLICY_FILE} in that
 * gateway's `additionalPolicies` so its role may make them (unless the gateway imports its role).
 * Changes nothing outside a Box project. Changes `spec` in place, and returns the step messages;
 * none when nothing changed. The target name on a gateway that is not a Box gateway is an error.
 */
export function addBoxMemoryTarget(spec: ProjectSpec, projectRoot: string): string[] {
  const runtimes = boxedRuntimesWithMemory(spec, projectRoot);
  if (runtimes.length === 0) return [];

  const owner = spec.agentCoreGateways.find(
    (gateway) =>
      !isBoundGateway(gateway) &&
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
    // ProjectSpecSchema requires a Box project to keep a gateway bound to each runtime.
    const gateway = spec.agentCoreGateways.find(
      ({ boundRuntime }) => boundRuntime === runtime.name,
    );
    if (!gateway) continue;
    if (!servesTarget(gateway.targets, getBoxGatewayAgentCoreTargetSpec())) {
      gateway.targets.push(getBoxGatewayAgentCoreTargetSpec());
      messages.push(
        `adding target '${BOX_MEMORY_TARGET}' to gateway '${gateway.name}' in agentcore.json, ` +
          "for the boxed agent's Memory calls",
      );
    }
    // An imported role (executionRoleArn) is the user's to grant; the L3 warns about it at synth.
    if (
      !gateway.executionRoleArn &&
      !gateway.additionalPolicies?.includes(BOX_MEMORY_POLICY_FILE)
    ) {
      gateway.additionalPolicies = [...(gateway.additionalPolicies ?? []), BOX_MEMORY_POLICY_FILE];
      messages.push(
        `adding '${BOX_MEMORY_POLICY_FILE}' to gateway '${gateway.name}' additionalPolicies in ` +
          "agentcore.json, so its role can call Memory",
      );
    }
  }
  return messages;
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
