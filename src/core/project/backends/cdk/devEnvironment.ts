import type { Stack } from "@aws-sdk/client-cloudformation";
import { InputValidationError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import type { TargetState } from "./deployedState";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const part of path) {
    current = record(current)?.[part];
  }
  return typeof current === "string" ? current : undefined;
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const part of path) {
    current = record(current)?.[part];
  }
  return current;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function entriesAt(value: unknown, ...path: string[]): [string, unknown][] {
  return Object.entries(record(valueAt(value, ...path)) ?? {});
}

function token(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function paymentId(name: string): string {
  return name.replace(/_/g, "");
}

function byExportName(stack: Stack | undefined, ...parts: string[]): string | undefined {
  if (!stack?.StackName) return undefined;
  const want = [stack.StackName, ...parts]
    .map((part) => part.replace(/_/g, "-").replace(/[^a-zA-Z0-9:-]/g, ""))
    .join("-");
  return stack.Outputs?.find((output) => output.ExportName === want)?.OutputValue;
}

function byOutputKey(stack: Stack | undefined, key: string): string | undefined {
  return stack?.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;
}

type EnvironmentWriter = (name: string, value: string | undefined, owner: string) => void;

function writer(env: Record<string, string>): EnvironmentWriter {
  const owners = new Map<string, string>();
  return (name, value, owner) => {
    if (value === undefined) return;
    const previous = env[name];
    if (previous !== undefined && previous !== value) {
      throw new InputValidationError(
        `${owners.get(name)} and ${owner} both map to environment variable ${name}. ` +
          "Rename one of the resources so local dev does not select an arbitrary value.",
      );
    }
    env[name] = value;
    owners.set(name, owner);
  };
}

/**
 * Builds the v0-compatible discovery variables for local dev, using the v0
 * state file when it contains the values and live stack outputs as the v1
 * fallback. The caller merges explicit local environment values afterwards.
 */
export function projectDevEnvironment({
  project,
  recorded,
  stack,
}: {
  project: Project;
  recorded?: TargetState;
  stack?: Stack;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const set = writer(env);
  const resources = recorded?.resources;

  // v0 discovered resources from deployed state rather than the current
  // project spec. Preserve that behavior when a resource was removed from
  // agentcore.json after its last deploy.
  for (const [name, memory] of entriesAt(resources, "memories")) {
    set(`MEMORY_${token(name)}_ID`, stringAt(memory, "memoryId"), `Memory "${name}"`);
  }

  for (const memory of project.spec.memories) {
    set(
      `MEMORY_${token(memory.name)}_ID`,
      stringAt(resources, "memories", memory.name, "memoryId") ??
        byExportName(stack, "Memory", memory.name, "Id"),
      `Memory "${memory.name}"`,
    );
  }

  const gatewayAuthType = (name: string): string =>
    project.spec.agentCoreGateways.find((gateway) => gateway.name === name)?.authorizerType ??
    "NONE";
  const recordedGateways = new Map<string, unknown>(entriesAt(resources, "gateways"));
  // The released v0 CLI reads the nested MCP branch. Prefer it when a state
  // file happens to contain both historical gateway layouts.
  for (const entry of entriesAt(resources, "mcp", "gateways")) {
    recordedGateways.set(...entry);
  }
  for (const [name, gateway] of recordedGateways) {
    const url = stringAt(gateway, "gatewayUrl");
    if (url === undefined) continue;
    const prefix = `AGENTCORE_GATEWAY_${token(name)}`;
    set(`${prefix}_URL`, url, `Gateway "${name}"`);
    set(`${prefix}_AUTH_TYPE`, gatewayAuthType(name), `Gateway "${name}"`);
  }

  for (const gateway of project.spec.agentCoreGateways) {
    const prefix = `AGENTCORE_GATEWAY_${token(gateway.name)}`;
    const stateUrl = stringAt(recordedGateways.get(gateway.name), "gatewayUrl");
    const url = stateUrl ?? byExportName(stack, "Gateway", gateway.name, "Url");
    if (url !== undefined) {
      set(`${prefix}_URL`, url, `Gateway "${gateway.name}"`);
      set(`${prefix}_AUTH_TYPE`, gateway.authorizerType ?? "NONE", `Gateway "${gateway.name}"`);
    }
  }

  const recordedPayments = new Set<string>();
  for (const [name, payment] of entriesAt(resources, "payments")) {
    const managerArn = stringAt(payment, "managerArn");
    if (managerArn === undefined) continue;
    recordedPayments.add(name);
    const prefix = `AGENTCORE_PAYMENT_${token(name)}`;
    const owner = `Payment manager "${name}"`;
    const firstConnector = entriesAt(payment, "connectors").find(
      ([, connector]) => stringAt(connector, "connectorId") !== undefined,
    );
    const autoPayment = valueAt(payment, "autoPayment");
    const allowlist = stringList(valueAt(payment, "paymentToolAllowlist"));
    const networks = stringList(valueAt(payment, "networkPreferences"));

    set(`${prefix}_MANAGER_ARN`, managerArn, owner);
    set(`${prefix}_PROCESS_PAYMENT_ROLE_ARN`, stringAt(payment, "processPaymentRoleArn"), owner);
    if (firstConnector) {
      set(
        `${prefix}_CONNECTOR_ID`,
        stringAt(firstConnector[1], "connectorId"),
        `Payment connector "${firstConnector[0]}"`,
      );
    }
    set(
      `${prefix}_AUTO_PAYMENT`,
      typeof autoPayment === "boolean" ? String(autoPayment) : undefined,
      owner,
    );
    set(`${prefix}_TOOL_ALLOWLIST`, allowlist?.length ? allowlist.join(",") : undefined, owner);
    set(`${prefix}_NETWORK_PREFERENCES`, networks?.length ? networks.join(",") : undefined, owner);
    set(
      `${prefix}_AUTH_MODE`,
      stringAt(payment, "authorizerType") === "CUSTOM_JWT" ? "bearer" : undefined,
      owner,
    );
  }

  for (const payment of project.spec.payments ?? []) {
    if (recordedPayments.has(payment.name)) continue;
    const prefix = `AGENTCORE_PAYMENT_${token(payment.name)}`;
    const managerId = `Payment${paymentId(payment.name)}`;
    const managerArn = byOutputKey(stack, `${managerId}ManagerArn`);
    if (managerArn === undefined) continue;

    set(`${prefix}_MANAGER_ARN`, managerArn, `Payment manager "${payment.name}"`);
    set(
      `${prefix}_PROCESS_PAYMENT_ROLE_ARN`,
      byOutputKey(stack, `${managerId}ProcessPaymentRoleArn`),
      `Payment manager "${payment.name}"`,
    );

    const firstConnector = payment.connectors[0];
    if (firstConnector) {
      set(
        `${prefix}_CONNECTOR_ID`,
        byOutputKey(stack, `${managerId}${paymentId(firstConnector.name)}ConnectorId`),
        `Payment connector "${firstConnector.name}"`,
      );
    }

    set(`${prefix}_AUTO_PAYMENT`, String(payment.autoPayment), `Payment manager "${payment.name}"`);
    set(
      `${prefix}_TOOL_ALLOWLIST`,
      payment.paymentToolAllowlist?.length ? payment.paymentToolAllowlist.join(",") : undefined,
      `Payment manager "${payment.name}"`,
    );
    set(
      `${prefix}_NETWORK_PREFERENCES`,
      payment.networkPreferences?.length ? payment.networkPreferences.join(",") : undefined,
      `Payment manager "${payment.name}"`,
    );
    set(
      `${prefix}_AUTH_MODE`,
      payment.authorizerType === "CUSTOM_JWT" ? "bearer" : undefined,
      `Payment manager "${payment.name}"`,
    );
  }

  return env;
}
