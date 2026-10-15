import { createHash } from "node:crypto";
import { InputValidationError } from "../../../../errors";
import type { DeployableResource, Project } from "../../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AgentCoreGateway } from "../../../../projectSchemas/gateway";
import type { SchemaDefinition } from "../../../../projectSchemas/mcp-defs";
import {
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  type Memory,
} from "../../../../projectSchemas/memory";
import type { OnlineEvalConfig } from "../../../../projectSchemas/online-eval-config";
import type { PolicyEngine } from "../../../../projectSchemas/policy";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";

type Attributes = Record<string, unknown>;
export type TerraformArtifact = { path: string; hash: string };
export type TerraformAssets = {
  runtimes: Record<string, TerraformArtifact>;
  /** Keys are gateway-name/target-name. */
  gatewayTargets: Record<string, TerraformArtifact>;
};
export type TerraformResourceDescriptor = {
  resourceType: DeployableResource;
  name: string;
  parentName?: string;
};
export type TerraformConfiguration = {
  terraform: Attributes;
  provider: Attributes;
  resource: Record<string, Record<string, Attributes>>;
  output: Record<string, { value: unknown }>;
};

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

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 10);
const key = (name: string) => `r_${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${digest(name)}`;
const ref = (address: string, attribute: string) => `\${${address}.${attribute}}`;
/** All customer strings are Terraform string literals, never expressions. */
const literal = (value: string) => value.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
const optional = (value?: string) => (value === undefined ? undefined : literal(value));
const tagMap = (project: Project, tags?: Record<string, string>) =>
  Object.fromEntries(
    Object.entries({ ...project.spec.tags, ...tags }).map(([name, value]) => [
      name,
      literal(value),
    ]),
  );
const tagList = (tags: Record<string, string>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));
const statement = (actions: string[], resources: string[]) => ({
  Effect: "Allow",
  Action: actions,
  Resource: resources,
});
const policyDocument = (statements: Attributes[]) =>
  JSON.stringify({ Version: "2012-10-17", Statement: statements });
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

/** Compiles the deliberately bounded Terraform PoC without performing I/O or deploying resources. */
export class TerraformCompiler {
  private resources: TerraformConfiguration["resource"] = {};
  private outputs: TerraformConfiguration["output"] = {};
  private deployed: Attributes[] = [];
  private project!: Project;
  private target!: AwsDeploymentTarget;
  private partition = "aws";

  preflight(project: Project): void {
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
      if (!runtime.entrypoint.endsWith(".py"))
        reject(`${path}.entrypoint`, "must be a Python script without a handler suffix");
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
            ["URL", "ARN", "ID"]
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

  compile(
    project: Project,
    target: AwsDeploymentTarget,
    assets: TerraformAssets,
  ): TerraformConfiguration {
    this.preflight(project);
    this.resources = {};
    this.outputs = {};
    this.deployed = [];
    this.project = project;
    this.target = target;
    this.partition = target.region.startsWith("cn-")
      ? "aws-cn"
      : target.region.startsWith("us-gov-")
        ? "aws-us-gov"
        : "aws";
    if (
      project.spec.runtimes.length ||
      project.spec.agentCoreGateways.some((gateway) => gateway.targets.length)
    )
      this.artifactBucket();
    for (const memory of project.spec.memories) this.memory(memory);
    for (const engine of project.spec.policyEngines) this.policyEngine(engine);
    for (const gateway of project.spec.agentCoreGateways) this.gateway(gateway, assets);
    for (const runtime of project.spec.runtimes) this.runtime(runtime, assets);
    for (const config of project.spec.onlineEvalConfigs) this.onlineEvaluation(config);
    this.outputs.project_resources = { value: this.deployed };
    return {
      terraform: {
        required_version: ">= 1.12.0, < 2.0.0",
        required_providers: {
          awscc: { source: "hashicorp/awscc", version: "= 1.106.0" },
          aws: { source: "hashicorp/aws", version: "= 6.69.0" },
        },
      },
      provider: {
        awscc: { region: target.region },
        aws: { region: target.region, allowed_account_ids: [target.account] },
      },
      resource: this.resources,
      output: this.outputs,
    };
  }

  private add(type: string, name: string, attributes: Attributes): string {
    const label = key(name);
    (this.resources[type] ??= {})[label] = attributes;
    return `${type}.${label}`;
  }
  private address(type: string, name: string): string {
    return `${type}.${key(name)}`;
  }
  private physical(name: string, limit = 48, separator = "_"): string {
    const full = `${this.project.name}${separator}${this.target.name}${separator}${name}`.replace(
      separator === "_" ? /[^a-zA-Z0-9_]/g : /[^a-zA-Z0-9-]/g,
      separator,
    );
    return full.length <= limit ? full : `${full.slice(0, limit - 11)}${separator}${digest(full)}`;
  }
  private arn(service: string, resource: string): string {
    return `arn:${this.partition}:${service}:${this.target.region}:${this.target.account}:${resource}`;
  }
  private gatewayPrefix(name: string): string {
    return `AGENTCORE_GATEWAY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }
  private publish(
    resourceType: DeployableResource,
    name: string,
    id: string,
    arn?: string,
    parentName?: string,
  ): void {
    this.deployed.push({
      resourceType,
      name,
      id,
      ...(arn ? { arn } : {}),
      ...(parentName ? { parentName } : {}),
    });
    this.outputs[`${key(`${resourceType}/${parentName ?? ""}/${name}`)}_id`] = { value: id };
    if (arn)
      this.outputs[`${key(`${resourceType}/${parentName ?? ""}/${name}`)}_arn`] = { value: arn };
  }
  private role(
    name: string,
    service: string,
    statements: Attributes[],
    sourceArn?: string | string[],
  ): { arn: string; dependency: string } {
    const role = this.add("aws_iam_role", name, {
      name: this.physical(name, 64, "-"),
      assume_role_policy: policyDocument([
        {
          Effect: "Allow",
          Principal: { Service: service },
          Action: "sts:AssumeRole",
          ...(sourceArn
            ? {
                Condition: {
                  StringEquals: {
                    "aws:SourceAccount": this.target.account,
                    "aws:ResourceAccount": this.target.account,
                  },
                  ArnLike: { "aws:SourceArn": sourceArn },
                },
              }
            : {}),
        },
      ]),
      tags: tagMap(this.project),
    });
    const dependency = statements.length
      ? this.add("aws_iam_role_policy", name, {
          name: "agentcore-poc",
          role: ref(role, "id"),
          policy: policyDocument(statements),
        })
      : role;
    return { arn: ref(role, "arn"), dependency };
  }
  private artifactBucket(): void {
    const bucket = this.add("aws_s3_bucket", "artifacts", {
      bucket: `agentcore-tf-${digest(`${this.project.name}/${this.target.name}/${this.target.account}/${this.target.region}`)}-${this.target.account}`,
      force_destroy: true,
      tags: tagMap(this.project),
    });
    this.add("aws_s3_bucket_public_access_block", "artifacts", {
      bucket: ref(bucket, "id"),
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
    this.add("aws_s3_bucket_server_side_encryption_configuration", "artifacts", {
      bucket: ref(bucket, "id"),
      rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256" }] }],
    });
  }
  private asset(name: string, artifact?: TerraformArtifact): string {
    if (!artifact)
      throw new InputValidationError(
        `Missing packaged Terraform artifact for ${name}. Run agentcore build first.`,
      );
    return this.add("aws_s3_object", name, {
      bucket: ref(this.address("aws_s3_bucket", "artifacts"), "id"),
      key: `${name}/${artifact.hash}.zip`,
      source: literal(artifact.path),
      source_hash: artifact.hash,
      content_type: "application/zip",
      server_side_encryption: "AES256",
    });
  }
  private memory(memory: Memory): void {
    const strategyKeys = {
      SEMANTIC: "semantic_memory_strategy",
      SUMMARIZATION: "summary_memory_strategy",
      USER_PREFERENCE: "user_preference_memory_strategy",
      EPISODIC: "episodic_memory_strategy",
    };
    // Built-in strategies do not require model permissions in the execution role.
    // Keep the service role explicit, like the L3, so its lifecycle is owned here.
    const role = this.role(
      `memory/${memory.name}`,
      "bedrock-agentcore.amazonaws.com",
      [],
      this.arn("bedrock-agentcore", `memory/${this.physical(memory.name)}*`),
    );
    const resource = this.add("awscc_bedrockagentcore_memory", memory.name, {
      name: this.physical(memory.name),
      description: optional(memory.description),
      event_expiry_duration: memory.eventExpiryDuration,
      memory_execution_role_arn: role.arn,
      indexed_keys: memory.indexedKeys?.map(({ key, type }) => ({ key: literal(key), type })),
      memory_strategies: memory.strategies.map((strategy) => ({
        [strategyKeys[strategy.type]]: {
          name:
            strategy.name ??
            `${memory.name}_${strategy.type.charAt(0)}${strategy.type.slice(1).toLowerCase().replace(/_/g, "")}`,
          description: optional(strategy.description),
          namespace_templates: (
            strategy.namespaceTemplates ??
            strategy.namespaces ??
            DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[strategy.type]
          )?.map(literal),
          ...(strategy.type === "EPISODIC"
            ? {
                reflection_configuration: {
                  namespace_templates: (
                    strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces
                  )?.map(literal),
                },
              }
            : {}),
        },
      })),
      tags: tagMap(this.project, memory.tags),
    });
    this.publish("memory", memory.name, ref(resource, "memory_id"), ref(resource, "memory_arn"));
  }
  private policyEngine(engine: PolicyEngine): void {
    const resource = this.add("awscc_bedrockagentcore_policy_engine", engine.name, {
      name: this.physical(engine.name),
      description: optional(engine.description),
      encryption_key_arn: optional(engine.encryptionKeyArn),
      tags: tagList(tagMap(this.project, engine.tags)),
    });
    this.publish(
      "policy-engine",
      engine.name,
      ref(resource, "policy_engine_id"),
      ref(resource, "policy_engine_arn"),
    );
    for (const policy of engine.policies) {
      const policyResource = this.add(
        "awscc_bedrockagentcore_policy",
        `${engine.name}/${policy.name}`,
        {
          name: policy.name,
          policy_engine_id: ref(resource, "policy_engine_id"),
          definition: { policy: { statement: literal(policy.statement) } },
          description: optional(policy.description),
          enforcement_mode: policy.enforcementMode,
          validation_mode: policy.validationMode,
        },
      );
      this.publish(
        "policy",
        policy.name,
        ref(policyResource, "policy_id"),
        ref(policyResource, "policy_arn"),
        engine.name,
      );
    }
  }
  private gateway(gateway: AgentCoreGateway, assets: TerraformAssets): void {
    const lambdaArns: string[] = [];
    const lambdaDependencies: string[] = [];
    for (const target of gateway.targets) {
      if (target.compute?.host !== "Lambda") continue; // preflight guarantees Lambda
      const name = `${gateway.name}/${target.name}`;
      const compute = target.compute;
      const lambdaName = this.physical(name, 64, "-");
      const logs = this.add("aws_cloudwatch_log_group", `lambda/${name}`, {
        name: `/aws/lambda/${lambdaName}`,
        retention_in_days: 7,
        tags: tagMap(this.project),
      });
      const role = this.role(`lambda/${name}`, "lambda.amazonaws.com", [
        statement(["logs:CreateLogStream", "logs:PutLogEvents"], [`${ref(logs, "arn")}:*`]),
        ...(compute.iamPolicy
          ? compute.iamPolicy.Statement.map(
              (entry) => JSON.parse(literal(JSON.stringify(entry))) as Attributes,
            )
          : []),
      ]);
      const asset = this.asset(`lambda/${name}`, assets.gatewayTargets[name]);
      const lambda = this.add("aws_lambda_function", name, {
        function_name: lambdaName,
        role: role.arn,
        runtime: `python${compute.pythonVersion!.replace("PYTHON_", "").replace("_", ".")}`,
        handler: compute.implementation.handler,
        architectures: ["arm64"],
        timeout: compute.timeout ?? 30,
        memory_size: compute.memorySize ?? 512,
        s3_bucket: ref(asset, "bucket"),
        s3_key: ref(asset, "key"),
        source_code_hash: Buffer.from(assets.gatewayTargets[name]!.hash, "hex").toString("base64"),
        tags: tagMap(this.project),
        depends_on: [role.dependency],
      });
      lambdaArns.push(ref(lambda, "arn"));
      lambdaDependencies.push(lambda);
    }
    const policies: Attributes[] = lambdaArns.length
      ? [statement(["lambda:InvokeFunction"], lambdaArns)]
      : [];
    const engine = gateway.policyEngineConfiguration
      ? this.address(
          "awscc_bedrockagentcore_policy_engine",
          gateway.policyEngineConfiguration.policyEngineName,
        )
      : undefined;
    if (engine)
      policies.push(
        statement(
          [
            "bedrock-agentcore:GetPolicyEngine",
            "bedrock-agentcore:CheckAuthorizePermissions",
            "bedrock-agentcore:AuthorizeAction",
            "bedrock-agentcore:PartiallyAuthorizeActions",
          ],
          [ref(engine, "policy_engine_arn"), this.arn("bedrock-agentcore", "gateway/*")],
        ),
      );
    // An empty gateway still needs a role but no arbitrary resource grants.
    const role = this.role(
      `gateway/${gateway.name}`,
      "bedrock-agentcore.amazonaws.com",
      policies,
      this.arn("bedrock-agentcore", "gateway/*"),
    );
    const resource = this.add("awscc_bedrockagentcore_gateway", gateway.name, {
      name: gateway.resourceName ?? this.physical(gateway.name, 100, "-"),
      authorizer_type: "AWS_IAM",
      role_arn: role.arn,
      protocol_type: "MCP",
      description: optional(gateway.description),
      exception_level: gateway.exceptionLevel === "DEBUG" ? "DEBUG" : undefined,
      protocol_configuration: {
        mcp: {
          ...(gateway.enableSemanticSearch ? { search_type: "SEMANTIC" } : {}),
          supported_versions: ["2025-03-26"],
        },
      },
      policy_engine_configuration: engine
        ? { arn: ref(engine, "policy_engine_arn"), mode: gateway.policyEngineConfiguration!.mode }
        : undefined,
      tags: tagMap(this.project, gateway.tags),
      depends_on: [role.dependency],
    });
    this.publish(
      "gateway",
      gateway.name,
      ref(resource, "gateway_identifier"),
      ref(resource, "gateway_arn"),
    );
    this.outputs[`${key(`gateway/${gateway.name}`)}_url`] = { value: ref(resource, "gateway_url") };
    for (const target of gateway.targets) {
      const name = `${gateway.name}/${target.name}`;
      const lambda = this.address("aws_lambda_function", name);
      // AWSCC 1.106.0 does not ship GatewayTarget. The native provider owns this
      // resource's full CRUD lifecycle while referring to the AWSCC gateway.
      const resourceTarget = this.add("aws_bedrockagentcore_gateway_target", name, {
        name: literal(target.name),
        gateway_identifier: ref(resource, "gateway_identifier"),
        credential_provider_configuration: [{ gateway_iam_role: [{}] }],
        target_configuration: [
          {
            mcp: [
              {
                lambda: [
                  {
                    lambda_arn: ref(lambda, "arn"),
                    tool_schema: [
                      {
                        inline_payload: target.toolDefinitions!.map((tool) => ({
                          name: literal(tool.name),
                          description: literal(tool.description),
                          input_schema: [this.toolSchema(tool.inputSchema)],
                          ...(tool.outputSchema
                            ? { output_schema: [this.toolSchema(tool.outputSchema)] }
                            : {}),
                        })),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        depends_on: [role.dependency, ...lambdaDependencies],
      });
      this.publish(
        "gateway-target",
        target.name,
        ref(resourceTarget, "target_id"),
        undefined,
        gateway.name,
      );
    }
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

  private toolSchema(
    schema: SchemaDefinition,
    kind: "root" | "property" | "items" | "leaf" = "root",
  ): Attributes {
    const result: Attributes = { type: schema.type, description: optional(schema.description) };
    if (kind === "leaf") {
      if (schema.items) result.items_json = literal(JSON.stringify(schema.items));
      if (schema.properties)
        result.properties_json = literal(
          JSON.stringify({ properties: schema.properties, required: schema.required ?? [] }),
        );
    } else {
      if (schema.items)
        result.items = [this.toolSchema(schema.items, kind === "items" ? "leaf" : "items")];
      if (schema.properties)
        result.property = Object.entries(schema.properties).map(([name, value]) => ({
          name: literal(name),
          required: schema.required?.includes(name) ?? false,
          ...this.toolSchema(value, kind === "root" ? "property" : "leaf"),
        }));
    }
    return result;
  }
  private runtime(runtime: ProjectRuntime, assets: TerraformAssets): void {
    const physicalName = this.physical(runtime.name);
    const artifact = this.asset(`runtime/${runtime.name}`, assets.runtimes[runtime.name]);
    const memoryArns = this.project.spec.memories
      .map((memory) =>
        ref(this.address("awscc_bedrockagentcore_memory", memory.name), "memory_arn"),
      )
      .sort();
    const gatewayArns = this.project.spec.agentCoreGateways
      .map((gateway) =>
        ref(this.address("awscc_bedrockagentcore_gateway", gateway.name), "gateway_arn"),
      )
      .sort();
    const statements: Attributes[] = [
      statement(["s3:GetObject"], [`${ref(this.address("aws_s3_bucket", "artifacts"), "arn")}/*`]),
      statement(
        [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:PutResourcePolicy",
        ],
        [this.arn("logs", `log-group:/aws/bedrock-agentcore/runtimes/${physicalName}-*`)],
      ),
      statement(
        [
          "logs:DescribeLogGroups",
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "cloudwatch:PutMetricData",
        ],
        ["*"],
      ),
      statement(
        ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        [
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
          `arn:${this.partition}:bedrock:*:${this.target.account}:inference-profile/*`,
          `arn:${this.partition}:bedrock:*:${this.target.account}:application-inference-profile/*`,
        ],
      ),
      statement(
        [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        [
          this.arn("bedrock-agentcore", "workload-identity-directory/default"),
          this.arn("bedrock-agentcore", "workload-identity-directory/default/workload-identity/*"),
        ],
      ),
    ];
    if (memoryArns.length)
      statements.push(
        statement(
          [
            "bedrock-agentcore:CreateEvent",
            "bedrock-agentcore:DeleteEvent",
            "bedrock-agentcore:GetEvent",
            "bedrock-agentcore:GetMemory",
            "bedrock-agentcore:GetMemoryRecord",
            "bedrock-agentcore:ListActors",
            "bedrock-agentcore:ListEvents",
            "bedrock-agentcore:ListSessions",
            "bedrock-agentcore:ListMemoryRecords",
            "bedrock-agentcore:RetrieveMemoryRecords",
            "bedrock-agentcore:DeleteMemoryRecord",
          ],
          memoryArns,
        ),
      );
    if (gatewayArns.length)
      statements.push(statement(["bedrock-agentcore:InvokeGateway"], gatewayArns));
    const role = this.role(
      `runtime/${runtime.name}`,
      "bedrock-agentcore.amazonaws.com",
      statements,
      this.arn("bedrock-agentcore", "runtime/*"),
    );
    const environment: Record<string, string> = Object.fromEntries(
      (runtime.envVars ?? []).map(({ name, value }) => [name, literal(value)]),
    );
    for (const memory of this.project.spec.memories) {
      const address = this.address("awscc_bedrockagentcore_memory", memory.name);
      environment[`MEMORY_${memory.name.toUpperCase()}_ID`] = ref(address, "memory_id");
      environment[`MEMORY_${memory.name.toUpperCase()}_ARN`] = ref(address, "memory_arn");
    }
    for (const gateway of this.project.spec.agentCoreGateways) {
      const address = this.address("awscc_bedrockagentcore_gateway", gateway.name);
      for (const [suffix, attribute] of Object.entries({
        URL: "gateway_url",
        ARN: "gateway_arn",
        ID: "gateway_identifier",
      }))
        environment[`${this.gatewayPrefix(gateway.name)}_${suffix}`] = ref(address, attribute);
    }
    const instrumented = runtime.instrumentation?.enableOtel ?? true;
    // Hosted runtimes inject their OTEL exporter, resource attributes and unified
    // trace destination. Overriding those here would lose the runtime identifier.
    const resource = this.add("awscc_bedrockagentcore_runtime", runtime.name, {
      agent_runtime_name: physicalName,
      description: optional(runtime.description),
      role_arn: role.arn,
      agent_runtime_artifact: {
        code_configuration: {
          code: { s3: { bucket: ref(artifact, "bucket"), prefix: ref(artifact, "key") } },
          runtime: runtime.runtimeVersion,
          entry_point: instrumented
            ? ["opentelemetry-instrument", literal(runtime.entrypoint)]
            : [literal(runtime.entrypoint)],
        },
      },
      network_configuration: { network_mode: "PUBLIC" },
      protocol_configuration: runtime.protocol ?? "HTTP",
      environment_variables: environment,
      request_header_configuration: runtime.requestHeaderAllowlist
        ? { request_header_allowlist: runtime.requestHeaderAllowlist.map(literal) }
        : undefined,
      lifecycle_configuration: runtime.lifecycleConfiguration
        ? {
            idle_runtime_session_timeout: runtime.lifecycleConfiguration.idleRuntimeSessionTimeout,
            max_lifetime: runtime.lifecycleConfiguration.maxLifetime,
          }
        : undefined,
      tags: tagMap(this.project, runtime.tags),
      depends_on: [role.dependency],
    });
    this.publish(
      "runtime",
      runtime.name,
      ref(resource, "agent_runtime_id"),
      ref(resource, "agent_runtime_arn"),
    );
    this.add("aws_cloudwatch_log_group", `runtime/${runtime.name}`, {
      name: `/aws/bedrock-agentcore/runtimes/${ref(resource, "agent_runtime_id")}-DEFAULT`,
      retention_in_days: 7,
      tags: tagMap(this.project),
    });
  }
  private onlineEvaluation(config: OnlineEvalConfig): void {
    const runtime = this.project.spec.runtimes.find((entry) => entry.name === config.agent)!;
    const runtimeLogs = this.address("aws_cloudwatch_log_group", `runtime/${runtime.name}`);
    const name = this.physical(config.name);
    const outputLogs = this.add("aws_cloudwatch_log_group", `evaluation/${config.name}`, {
      name: `/aws/bedrock-agentcore/evaluations/${name}`,
      retention_in_days: 7,
      tags: tagMap(this.project),
    });
    const role = this.role(
      `evaluation/${config.name}`,
      "bedrock-agentcore.amazonaws.com",
      [
        statement(
          [
            "logs:StartQuery",
            "logs:FilterLogEvents",
            "logs:GetLogEvents",
            "logs:DescribeLogStreams",
          ],
          [
            ref(runtimeLogs, "arn"),
            `${ref(runtimeLogs, "arn")}:*`,
            this.arn("logs", "log-group:aws/spans"),
            this.arn("logs", "log-group:aws/spans:*"),
          ],
        ),
        statement(
          ["logs:DescribeIndexPolicies", "logs:PutIndexPolicy"],
          [this.arn("logs", "log-group:aws/spans"), this.arn("logs", "log-group:aws/spans:*")],
        ),
        statement(
          [
            "logs:DescribeLogGroups",
            "logs:GetQueryResults",
            "logs:StopQuery",
            "cloudwatch:GenerateQuery",
            "cloudwatch:GenerateQueryResultsSummary",
            "cloudwatch:PutMetricData",
            "xray:GetTraceSummaries",
            "xray:BatchGetTraces",
          ],
          ["*"],
        ),
        statement(["logs:CreateLogStream", "logs:PutLogEvents"], [`${ref(outputLogs, "arn")}:*`]),
        statement(
          ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          [
            `arn:${this.partition}:bedrock:*::foundation-model/*`,
            `arn:${this.partition}:bedrock:*:${this.target.account}:inference-profile/*`,
            `arn:${this.partition}:bedrock:*:${this.target.account}:application-inference-profile/*`,
          ],
        ),
        statement(
          ["bedrock-agentcore:Evaluate", "bedrock-agentcore:GetEvaluator"],
          config.evaluators.map(
            (evaluator) => `arn:${this.partition}:bedrock-agentcore:::evaluator/${evaluator}`,
          ),
        ),
        statement(
          ["bedrock-agentcore:StartBatchEvaluation"],
          [this.arn("bedrock-agentcore", "batch-evaluate/*")],
        ),
        statement(
          ["bedrock-agentcore:GetOnlineEvaluationConfig"],
          [this.arn("bedrock-agentcore", `online-evaluation-config/${name}-*`)],
        ),
      ],
      [
        this.arn("bedrock-agentcore", "online-evaluation-config/*"),
        this.arn("bedrock-agentcore", "evaluator/*"),
      ],
    );
    const resource = this.add("awscc_bedrockagentcore_online_evaluation_config", config.name, {
      online_evaluation_config_name: name,
      description: optional(config.description),
      evaluation_execution_role_arn: role.arn,
      data_source_config: {
        cloudwatch_logs: {
          log_group_names: [ref(runtimeLogs, "name")],
          service_names: [`${this.physical(runtime.name)}.DEFAULT`],
        },
      },
      evaluators: config.evaluators.map((evaluator) => ({ evaluator_id: literal(evaluator) })),
      rule: {
        sampling_config: { sampling_percentage: config.samplingRate },
        session_config: { session_timeout_minutes: 5 },
      },
      execution_status: config.enableOnCreate === false ? "DISABLED" : "ENABLED",
      output_config: {
        cloudwatch_config: {
          log_group_name: ref(outputLogs, "name"),
          result_destination: "DEDICATED_LOG_GROUP",
        },
      },
      tags: tagList(tagMap(this.project, config.tags)),
      depends_on: [role.dependency],
    });
    this.publish(
      "online-eval",
      config.name,
      ref(resource, "online_evaluation_config_id"),
      ref(resource, "online_evaluation_config_arn"),
    );
  }
}
