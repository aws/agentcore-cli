import { InputValidationError } from "../../errors/errors";
import {
  BOX_GATEWAY_POLICY_ENGINE_MODE,
  boxGatewayPolicyEngineName,
  getBoxGatewayEntry,
  getBoxGatewayPolicyEngineSpec,
} from "../../handlers/project/shortcuts";
import { boxGatewayName, type ProjectSpec } from "../../projectSchemas/project";
import { boxEgressRoutes, getBoxEgressTargetSpec } from "./boxEgress";
import { runsAgentInBox } from "./backends/boxContainer";

/**
 * Adds a passthrough target to each boxed runtime's Box gateway, `<runtime>-box`,
 * for every box egress in `.box/profile.toml` that fronts an `env://` API key, so
 * the box can send the agent's calls to those destinations through the gateway
 * and the gateway adds the key from AgentCore Identity. The target name is the
 * egress name, which is also the API key credential name that
 * `addBoxProfileCredentials` declares.
 *
 * Mirrors {@link addBoxMemoryTarget}: it changes `spec` in place, marks the
 * project `"projectType": "box"`, recreates a gateway and its policy engine when
 * missing, and returns the step messages; none when nothing changed. A target of
 * the egress name on a gateway that is not a Box gateway is an error.
 */
export function addBoxEgressTargets(spec: ProjectSpec, projectRoot: string): string[] {
  const routes = boxEgressRoutes(projectRoot);
  if (routes.length === 0) return [];

  const boxedRuntimes = spec.runtimes.filter((runtime) => runsAgentInBox(projectRoot, runtime));
  if (boxedRuntimes.length === 0) return [];

  const boxGateways = new Set(spec.runtimes.map(({ name }) => boxGatewayName(name)));
  for (const gateway of spec.agentCoreGateways) {
    if (boxGateways.has(gateway.name)) continue;
    for (const route of routes) {
      if (gateway.targets.some((target) => target.name === route.name)) {
        throw new InputValidationError(
          `gateway '${gateway.name}' has a target named '${route.name}', the name the Box ` +
            `gateway needs for the box egress '${route.name}'. Rename that target.`,
        );
      }
    }
  }

  const messages: string[] = [];
  if (spec.projectType !== "box") {
    spec.projectType = "box";
    messages.push(`setting "projectType": "box" in agentcore.json, for the Box gateway`);
  }
  for (const runtime of boxedRuntimes) {
    const name = boxGatewayName(runtime.name);
    let gateway = spec.agentCoreGateways.find((entry) => entry.name === name);
    if (!gateway) {
      gateway = getBoxGatewayEntry(runtime.name);
      spec.agentCoreGateways.push(gateway);
      messages.push(`adding gateway '${name}' to agentcore.json`);
    }
    for (const route of routes) {
      if (gateway.targets.some((target) => target.name === route.name)) continue;
      gateway.targets.push(getBoxEgressTargetSpec(route));
      messages.push(
        `adding target '${route.name}' to gateway '${name}' in agentcore.json, ` +
          `for the box egress to ${route.destinations.join(", ")}`,
      );
    }
    // A gateway from an older project may lack a policy engine. Attach it, and declare it, if
    // either is missing, as addBoxMemoryTarget does.
    const engineName = boxGatewayPolicyEngineName(runtime.name);
    if (!gateway.policyEngineConfiguration) {
      gateway.policyEngineConfiguration = {
        policyEngineName: engineName,
        mode: BOX_GATEWAY_POLICY_ENGINE_MODE,
      };
      messages.push(
        `attaching policy engine '${engineName}' to gateway '${name}' in agentcore.json`,
      );
    }
    if (!spec.policyEngines.some((engine) => engine.name === engineName)) {
      spec.policyEngines.push(getBoxGatewayPolicyEngineSpec(runtime.name));
      messages.push(
        `adding policy engine '${engineName}' to agentcore.json, for gateway '${name}'`,
      );
    }
  }
  return messages;
}
