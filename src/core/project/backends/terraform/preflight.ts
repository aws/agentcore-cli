import { InputValidationError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import type { SchemaDefinition } from "../../../../projectSchemas/mcp-defs";
import type { TerraformResourceDescriptor } from "./types";

export function declaredResources(project: Project): TerraformResourceDescriptor[] {
  return [
    ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
    ...project.spec.memories.map(({ name }) => ({ resourceType: "memory" as const, name })),
    ...project.spec.policyEngines.flatMap(({ name, policies }) => [
      { resourceType: "policy-engine" as const, name },
      ...policies.map((policy) => ({
        resourceType: "policy" as const,
        name: policy.name,
        parentName: name,
      })),
    ]),
    ...project.spec.agentCoreGateways.flatMap(({ name, targets }) => [
      { resourceType: "gateway" as const, name },
      ...targets.map((target) => ({
        resourceType: "gateway-target" as const,
        name: target.name,
        parentName: name,
      })),
    ]),
    ...project.spec.onlineEvalConfigs.map(({ name }) => ({
      resourceType: "online-eval" as const,
      name,
    })),
  ];
}

const hasValue = (value: unknown) =>
  value !== undefined && (!Array.isArray(value) || value.length > 0);

function reject(path: string, detail = "is not supported by the Terraform PoC"): never {
  throw new InputValidationError(`agentcore.json ${path}: ${detail}.`);
}
function fields(value: object, allowed: string[], path: string): void {
  for (const [name, entry] of Object.entries(value)) {
    if (hasValue(entry) && !allowed.includes(name)) reject(`${path}.${name}`);
  }
}

/** Checks the deliberately bounded CLI Terraform PoC before packaging or cloud operations. */
export class TerraformProjectValidator {
  validate(project: Project): void {
    fields(
      project.spec,
      [
        "name",
        "version",
        "managedBy",
        "tags",
        "runtimes",
        "memories",
        "policyEngines",
        "agentCoreGateways",
        "onlineEvalConfigs",
      ],
      "project",
    );
    for (const runtime of project.spec.runtimes) {
      const path = `runtimes[${runtime.name}]`;
      fields(
        runtime,
        [
          "name",
          "description",
          "modelProvider",
          "modelId",
          "build",
          "codeLocation",
          "entrypoint",
          "runtimeVersion",
          "envVars",
          "instrumentation",
          "networkMode",
          "authorizerType",
          "protocol",
          "requestHeaderAllowlist",
          "tags",
          "lifecycleConfiguration",
        ],
        path,
      );
      if (runtime.build !== "CodeZip") reject(`${path}.build`, "must be CodeZip for this PoC");
      if (!runtime.runtimeVersion?.startsWith("PYTHON_3_"))
        reject(`${path}.runtimeVersion`, "must select a Python managed runtime");
      if (runtime.networkMode && runtime.networkMode !== "PUBLIC")
        reject(`${path}.networkMode`, "must be PUBLIC for this PoC");
      if (runtime.authorizerType && runtime.authorizerType !== "AWS_IAM")
        reject(`${path}.authorizerType`, "must be AWS_IAM for this PoC");
      if (!runtime.entrypoint.split(":")[0]!.endsWith(".py"))
        reject(
          `${path}.entrypoint`,
          "must be a Python script, optionally followed by a handler suffix",
        );
      const environment = new Set<string>();
      for (const env of runtime.envVars ?? []) {
        if (environment.has(env.name))
          reject(`${path}.envVars`, `contains duplicate variable ${env.name}`);
        environment.add(env.name);
        const generated =
          project.spec.memories.some((memory) =>
            [
              `MEMORY_${memory.name.toUpperCase()}_ID`,
              `MEMORY_${memory.name.toUpperCase()}_ARN`,
            ].includes(env.name),
          ) ||
          project.spec.agentCoreGateways.some((gateway) =>
            ["URL", "ARN", "AUTH_TYPE"]
              .map((suffix) => `${this.gatewayPrefix(gateway.name)}_${suffix}`)
              .includes(env.name),
          );
        if (generated)
          reject(
            `${path}.envVars.${env.name}`,
            "conflicts with a project resource discovery variable",
          );
      }
    }
    const memoryVariables = new Set<string>();
    for (const memory of project.spec.memories) {
      const environmentName = memory.name.toUpperCase();
      if (memoryVariables.has(environmentName))
        reject(
          `memories[${memory.name}].name`,
          "collides with another memory's discovery variables",
        );
      memoryVariables.add(environmentName);
      fields(
        memory,
        ["name", "description", "eventExpiryDuration", "strategies", "indexedKeys", "tags"],
        `memories[${memory.name}]`,
      );
    }
    for (const engine of project.spec.policyEngines) {
      fields(
        engine,
        ["name", "description", "encryptionKeyArn", "tags", "policies"],
        `policyEngines[${engine.name}]`,
      );
      // sourceFile and authorizationPhase are CLI provenance/inference metadata. Like the L3,
      // the deployment uses the actual statement and the service determines authorization phase.
    }
    const gatewayVariables = new Set<string>();
    for (const gateway of project.spec.agentCoreGateways) {
      const path = `agentCoreGateways[${gateway.name}]`;
      fields(
        gateway,
        [
          "name",
          "resourceName",
          "protocolType",
          "description",
          "targets",
          "authorizerType",
          "enableSemanticSearch",
          "exceptionLevel",
          "policyEngineConfiguration",
          "tags",
        ],
        path,
      );
      if (gateway.authorizerType !== "AWS_IAM")
        reject(`${path}.authorizerType`, "must be AWS_IAM for this PoC");
      if (gateway.protocolType && gateway.protocolType !== "MCP")
        reject(`${path}.protocolType`, "must be MCP for this PoC");
      if (gatewayVariables.has(this.gatewayPrefix(gateway.name)))
        reject(`${path}.name`, "collides with another gateway's discovery variables");
      gatewayVariables.add(this.gatewayPrefix(gateway.name));
      const names = new Set<string>();
      for (const target of gateway.targets) {
        const targetPath = `${path}.targets[${target.name}]`;
        fields(
          target,
          ["name", "targetType", "toolDefinitions", "compute", "outboundAuth"],
          targetPath,
        );
        if (names.has(target.name)) reject(`${targetPath}.name`, "duplicates another target");
        names.add(target.name);
        if (target.targetType !== "lambda")
          reject(`${targetPath}.targetType`, "must be lambda for this PoC");
        if (
          target.compute?.host !== "Lambda" ||
          target.compute.implementation.language !== "Python"
        )
          reject(`${targetPath}.compute`, "must be a Python Lambda for this PoC");
        fields(
          target.compute,
          ["host", "implementation", "pythonVersion", "timeout", "memorySize", "iamPolicy"],
          `${targetPath}.compute`,
        );
        fields(
          target.compute.implementation,
          ["language", "path", "handler"],
          `${targetPath}.compute.implementation`,
        );
        if (target.compute.iamPolicy) {
          fields(
            target.compute.iamPolicy,
            ["Version", "Statement"],
            `${targetPath}.compute.iamPolicy`,
          );
          if (target.compute.iamPolicy.Version !== "2012-10-17")
            reject(`${targetPath}.compute.iamPolicy.Version`, "must be 2012-10-17");
        }
        if (target.compute.nodeVersion) reject(`${targetPath}.compute.nodeVersion`);
        if (target.outboundAuth && Object.keys(target.outboundAuth).some((name) => name !== "type"))
          reject(`${targetPath}.outboundAuth`);
        if (target.outboundAuth && target.outboundAuth.type !== "NONE")
          reject(`${targetPath}.outboundAuth.type`);
        if (
          !/^[a-zA-Z_][a-zA-Z0-9_.]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(
            target.compute.implementation.handler,
          )
        )
          reject(
            `${targetPath}.compute.implementation.handler`,
            "must use the Lambda module.function format",
          );
        for (const tool of target.toolDefinitions ?? []) {
          this.validateToolSchema(tool.inputSchema, `${targetPath}.${tool.name}.inputSchema`);
          if (tool.outputSchema)
            this.validateToolSchema(tool.outputSchema, `${targetPath}.${tool.name}.outputSchema`);
        }
      }
    }
    for (const config of project.spec.onlineEvalConfigs) {
      const path = `onlineEvalConfigs[${config.name}]`;
      if (!config.agent || config.logGroupNames || config.serviceNames)
        reject(path, "must reference a project runtime for this PoC");
      if (config.endpoint && config.endpoint !== "DEFAULT")
        reject(`${path}.endpoint`, "must use DEFAULT for this PoC");
      if (config.evaluators.some((name) => !name.startsWith("Builtin.")))
        reject(`${path}.evaluators`, "must contain built-in evaluators for this PoC");
      const runtime = project.spec.runtimes.find((entry) => entry.name === config.agent);
      if (!runtime) reject(`${path}.agent`, "references an unknown runtime");
      if (runtime.instrumentation?.enableOtel === false)
        reject(
          `${path}.agent`,
          "requires runtime OpenTelemetry instrumentation for online evaluation",
        );
      for (const env of runtime.envVars ?? []) {
        if (env.name.startsWith("OTEL_") || env.name === "UNIFIED_TRACES_DESTINATION_ENABLED")
          reject(
            `runtimes[${runtime.name}].envVars.${env.name}`,
            "cannot override service-managed telemetry while a project online evaluation uses this runtime",
          );
      }
    }
  }

  private gatewayPrefix(name: string): string {
    return `AGENTCORE_GATEWAY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }
  private validateToolSchema(schema: SchemaDefinition, path: string): void {
    if (schema.items && schema.type !== "array")
      reject(`${path}.items`, "requires an array schema");
    if ((schema.properties || schema.required?.length) && schema.type !== "object")
      reject(path, "properties and required are supported only on object schemas");
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(schema.properties ?? {}, required))
        reject(
          `${path}.required`,
          `references property ${required} without a declaration; the native provider cannot preserve it`,
        );
    }
    for (const [name, property] of Object.entries(schema.properties ?? {}))
      this.validateToolSchema(property, `${path}.properties.${name}`);
    if (schema.items) this.validateToolSchema(schema.items, `${path}.items`);
  }
}
