import { isReservedProjectName } from "./constants";
import { PRIVATE_VPC_LIMIT, ProjectRuntimeSchema, type Containment } from "./runtime";
import { AgentCoreGatewaySchema, REAL_KB_ID_PATTERN, ToolRuntimeSchema } from "./gateway";
import { ConfigBundleSchema } from "./config-bundle";
import { CredentialSchema, credentialEnvironmentVariableNames } from "./credential";
import { EvaluatorSchema } from "./evaluator";
import { HarnessRegistryEntrySchema } from "./harness";
import { KnowledgeBaseSchema } from "./knowledge-base";
import { MemorySchema } from "./memory";
import { OnlineEvalConfigSchema } from "./online-eval-config";
import { PaymentManagerSchema } from "./payment";
import { PolicyEngineSchema } from "./policy";
import { TagsSchema } from "./tags";
import { uniqueBy } from "./zod-util";
import { z } from "zod";
export const ManagedBySchema = z.enum(["CDK"]).default("CDK");
export type ManagedBy = z.infer<typeof ManagedBySchema>;
export const ProjectNameSchema = z
  .string()
  .min(1, "Project name is required")
  .max(23, "Project name must be 23 characters or less")
  .regex(
    /^[A-Za-z][A-Za-z0-9]{0,22}$/,
    "Project name must start with a letter and contain only alphanumeric characters",
  )
  .refine((name) => !isReservedProjectName(name), {
    message:
      "This name conflicts with a reserved package dependency. Please choose a different name.",
  });
/** The kind of project. `box` marks a project made from a Box template. */
export const ProjectTypeSchema = z.enum(["box"]);
/** Whether the project is a Box project, so the CLI keeps a Box gateway for each runtime. */
export const isBoxProject = (spec: { projectType?: string }) => spec.projectType === "box";
/**
 * The start of the name of each target that build adds to a Box gateway. Build manages every
 * target whose name has it, and no other.
 */
export const BOX_EGRESS_TARGET_PREFIX = "egress-";
/** The suffix of each Box gateway name: the runtime `agent` gets the gateway `agent-box-egress`. */
export const BOX_GATEWAY_SUFFIX = "-box-egress";
/**
 * The variable prefix of each Box gateway. The CLI sets it on every Box gateway, so agent code
 * reads `AGENTCORE_GATEWAY_BOX_URL` in every runtime, each pointing to that runtime's own gateway.
 */
export const BOX_GATEWAY_DISCOVERY_PREFIX = "AGENTCORE_GATEWAY_BOX";
/**
 * The name the CLI gives the Box gateway of a runtime. Gateway names do not permit `_`, so
 * `my_agent` gets `my-agent-box-egress`. Only `boxGatewaySpec` uses it: the CLI finds a runtime's
 * Box gateway by `boundRuntime`, not by name.
 */
export const boxGatewayName = (runtimeName: string): string =>
  `${runtimeName.replace(/_/g, "-")}${BOX_GATEWAY_SUFFIX}`;
/**
 * The Box gateway entry of a runtime, as the CLI writes it: bound to that runtime, under the fixed
 * variable prefix, `AWS_IAM` auth, `protocolType: "None"` and its `APPLICATION_LOGS` on. The CDK
 * library binds it from `boundRuntime` and `discoveryPrefix`. Build changes only its targets, so a
 * user's `enableApplicationLogs: false` stays.
 */
export const boxGatewaySpec = (runtimeName: string) => ({
  name: boxGatewayName(runtimeName),
  authorizerType: "AWS_IAM" as const,
  protocolType: "None" as const,
  boundRuntime: runtimeName,
  discoveryPrefix: BOX_GATEWAY_DISCOVERY_PREFIX,
  enableApplicationLogs: true,
  targets: [],
});
/**
 * Whether a gateway is bound to one runtime. Each Box gateway is: it belongs to its runtime, so
 * `remove runtime` removes it and `remove gateway` refuses it. It takes every target type.
 */
export const isBoundGateway = (gateway: { boundRuntime?: string }) =>
  gateway.boundRuntime !== undefined;
/** The variable prefix a gateway sets on each workload it binds to. Matches the CDK library. */
export const gatewayDiscoveryPrefix = (gateway: { name: string; discoveryPrefix?: string }) =>
  gateway.discoveryPrefix ??
  `AGENTCORE_GATEWAY_${gateway.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
/** Whether every resource collection of the spec is empty, as after `agentcore remove all`. */
export function declaresNoResources(spec: ProjectSpec): boolean {
  const collections = [
    spec.runtimes,
    spec.memories,
    spec.knowledgeBases,
    spec.credentials,
    spec.evaluators,
    spec.onlineEvalConfigs,
    spec.agentCoreGateways,
    spec.policyEngines,
    spec.configBundles,
    spec.harnesses,
    spec.toolRuntimes ?? [],
    spec.payments ?? [],
  ];
  return collections.every((collection) => collection.length === 0);
}
const BUILTIN_EVALUATOR_PREFIX = "Builtin.";
const ARN_PREFIX = "arn:";
const toEnvironmentName = (name: string) => name.replace(/-/g, "_").toUpperCase();
const uniqueNames = (resource: string) =>
  uniqueBy<{ name: string }>(
    ({ name }) => name,
    (name) => `Duplicate ${resource} name: ${name}`,
  );
export const ProjectSpecSchema = z
  .object({
    name: ProjectNameSchema,
    version: z.literal(2),
    /**
     * Set by `agentcore migrate` on a project it converted from the v0 CLI. `"v1"` is
     * the agentcore.json schema version the v0 CLI wrote (not the v1 CLI). It tells the
     * CDK library to keep v0's physical names for the whole project: no target segment,
     * and v0's fixed harness role names. Those names are create-only, so removing this
     * from a deployed project replaces its resources.
     */
    migratedFrom: z.literal("v1").optional(),
    managedBy: ManagedBySchema,
    tags: TagsSchema.optional(),
    /**
     * `"box"` for a Box project. `agentcore create` writes it when a Box template asks for it.
     * The CLI then keeps one gateway entry bound to each runtime (see `boxGatewaySpec`): `AWS_IAM`
     * auth, `protocolType: "None"`, `boundRuntime` and `discoveryPrefix`, from which the CDK library
     * binds it. The CDK library does not read this field. No default: the spec is written back to
     * disk after each parse, so a default would add the field to every existing project.
     */
    projectType: ProjectTypeSchema.optional(),
    runtimes: z.array(ProjectRuntimeSchema).default([]).superRefine(uniqueNames("agent")),
    memories: z.array(MemorySchema).default([]).superRefine(uniqueNames("memory")),
    knowledgeBases: z
      .array(KnowledgeBaseSchema)
      .default([])
      .superRefine(uniqueNames("knowledge base")),
    credentials: z.array(CredentialSchema).default([]).superRefine(uniqueNames("credential")),
    evaluators: z.array(EvaluatorSchema).default([]).superRefine(uniqueNames("evaluator")),
    onlineEvalConfigs: z
      .array(OnlineEvalConfigSchema)
      .default([])
      .superRefine(uniqueNames("online eval config")),
    agentCoreGateways: z
      .array(AgentCoreGatewaySchema)
      .default([])
      .superRefine(uniqueNames("gateway")),
    toolRuntimes: z.array(ToolRuntimeSchema).optional().superRefine(uniqueNames("tool runtime")),
    policyEngines: z
      .array(PolicyEngineSchema)
      .default([])
      .superRefine(uniqueNames("policy engine")),
    configBundles: z
      .array(ConfigBundleSchema)
      .default([])
      .superRefine(uniqueNames("config bundle")),
    harnesses: z.array(HarnessRegistryEntrySchema).default([]).superRefine(uniqueNames("harness")),
    payments: z.array(PaymentManagerSchema).optional().superRefine(uniqueNames("payment manager")),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const issue of containmentIssues(spec)) ctx.addIssue({ code: "custom", ...issue });
    const agentNames = new Set(spec.runtimes.map((a) => a.name));
    const evaluatorNames = new Set(spec.evaluators.map((e) => e.name));
    // A gateway bound to a runtime that does not exist binds to nothing and fails the synth.
    for (const gateway of spec.agentCoreGateways) {
      if (gateway.boundRuntime !== undefined && !agentNames.has(gateway.boundRuntime)) {
        ctx.addIssue({
          code: "custom",
          message: `Gateway "${gateway.name}" has boundRuntime "${gateway.boundRuntime}", but no runtime has that name`,
          path: ["agentCoreGateways"],
        });
      }
    }
    // A passthrough target that names a gateway calls a gateway of this project. A gateway bound to
    // a runtime belongs to that runtime, so no target of another gateway calls it. On the Box
    // gateway of a runtime of a Box project, build writes and removes each target whose name starts
    // with BOX_EGRESS_TARGET_PREFIX, so such a target that names no such gateway is not refused
    // here: the next build removes it.
    const buildOwns = (gateway: { boundRuntime?: string }, target: { name: string }) =>
      isBoxProject(spec) &&
      isBoundGateway(gateway) &&
      target.name.startsWith(BOX_EGRESS_TARGET_PREFIX);
    for (const gateway of spec.agentCoreGateways) {
      for (const target of gateway.targets) {
        const reached = target.passthrough?.gateway;
        if (reached === undefined || buildOwns(gateway, target)) continue;
        const named = spec.agentCoreGateways.find((other) => other.name === reached);
        const problem =
          named === undefined
            ? "but the project has no gateway of that name"
            : named === gateway
              ? "which is its own gateway"
              : named.boundRuntime !== undefined
                ? `which is bound to the runtime "${named.boundRuntime}"`
                : undefined;
        if (problem === undefined) continue;
        ctx.addIssue({
          code: "custom",
          message: `Target "${target.name}" of gateway "${gateway.name}" names the gateway "${reached}" in passthrough.gateway, ${problem}. Name a gateway of this project without boundRuntime`,
          path: ["agentCoreGateways"],
        });
      }
    }
    // A Box project keeps one Box gateway for each runtime. Without it, a deploy would delete the
    // deployed gateway, so every command stops here and prints the entry to add back.
    if (isBoxProject(spec)) {
      const bound = new Set(spec.agentCoreGateways.map((gateway) => gateway.boundRuntime));
      for (const runtime of spec.runtimes) {
        if (bound.has(runtime.name)) continue;
        ctx.addIssue({
          code: "custom",
          message:
            `Runtime "${runtime.name}" has no Box gateway. A Box project needs a gateway with ` +
            `boundRuntime "${runtime.name}" for each runtime, and a deploy without it would delete ` +
            `the deployed gateway. Add this entry to "agentCoreGateways" in agentcore.json, or ` +
            `delete the runtime from "runtimes" by hand:\n` +
            JSON.stringify(boxGatewaySpec(runtime.name), null, 2),
          path: ["agentCoreGateways"],
        });
      }
    }
    // Each gateway sets <prefix>_URL, _ARN, ... on each workload it binds to. Two gateways with the
    // same prefix on one workload set one variable to two values, which fails the synth. An unbound
    // gateway binds to every runtime and harness; a bound one binds to its runtime only.
    const unbound = spec.agentCoreGateways.filter((gateway) => !isBoundGateway(gateway));
    const workloads: [string, typeof unbound][] = [
      ["every runtime and harness", unbound],
      ...spec.runtimes.map((runtime): [string, typeof unbound] => [
        `runtime "${runtime.name}"`,
        [...unbound, ...spec.agentCoreGateways.filter((g) => g.boundRuntime === runtime.name)],
      ]),
    ];
    const reported = new Set<string>();
    for (const [workload, gateways] of workloads) {
      const byPrefix = new Map<string, string>();
      for (const gateway of gateways) {
        const prefix = gatewayDiscoveryPrefix(gateway);
        const other = byPrefix.get(prefix);
        byPrefix.set(prefix, gateway.name);
        if (other === undefined) continue;
        const key = [other, gateway.name].sort().join("\0");
        if (reported.has(key)) continue;
        reported.add(key);
        ctx.addIssue({
          code: "custom",
          message: `Gateways "${other}" and "${gateway.name}" both set ${prefix}_* on ${workload}. Rename one gateway or give it a different discoveryPrefix`,
          path: ["agentCoreGateways"],
        });
      }
    }
    for (const config of spec.onlineEvalConfigs) {
      if (config.agent && !agentNames.has(config.agent)) {
        ctx.addIssue({
          code: "custom",
          message: `Online eval config "${config.name}" references unknown agent "${config.agent}"`,
        });
      }
      for (const evalName of config.evaluators ?? []) {
        if (evalName.startsWith(BUILTIN_EVALUATOR_PREFIX) || evalName.startsWith(ARN_PREFIX))
          continue;
        if (!evaluatorNames.has(evalName)) {
          ctx.addIssue({
            code: "custom",
            message: `Online eval config "${config.name}" references unknown evaluator "${evalName}"`,
          });
        }
      }
    }
    const policyEngineNames = new Set(spec.policyEngines.map((engine) => engine.name));
    for (const gw of spec.agentCoreGateways ?? []) {
      const engineName = gw.policyEngineConfiguration?.policyEngineName;
      if (engineName && !policyEngineNames.has(engineName)) {
        ctx.addIssue({
          code: "custom",
          message: `Gateway "${gw.name}" references unknown policy engine "${engineName}". Check spec.policyEngines.`,
        });
      }
      for (const target of gw.targets) {
        if (target.targetType === "httpRuntime") {
          if (target.httpRuntime?.runtime) {
            const runtimeExists = spec.runtimes.some((r) => r.name === target.httpRuntime!.runtime);
            if (!runtimeExists) {
              ctx.addIssue({
                code: "custom",
                message: `Gateway "${gw.name}" target "${target.name}" references unknown runtime "${target.httpRuntime.runtime}". Check spec.runtimes.`,
              });
            } else if (
              target.httpRuntime.runtimeEndpoint &&
              target.httpRuntime.runtimeEndpoint !== "DEFAULT"
            ) {
              const runtime = spec.runtimes.find((r) => r.name === target.httpRuntime!.runtime);
              if (runtime && !runtime.endpoints?.[target.httpRuntime.runtimeEndpoint]) {
                ctx.addIssue({
                  code: "custom",
                  message: `Gateway "${gw.name}" target "${target.name}" references endpoint "${target.httpRuntime.runtimeEndpoint}" which does not exist on runtime "${target.httpRuntime.runtime}".`,
                });
              }
            }
          }
        }
      }
    }
    const knowledgeBaseNames = new Set((spec.knowledgeBases ?? []).map((kb) => kb.name));
    const validateKbReference = (
      target: {
        name: string;
      },
      value: string,
      fieldLabel: string,
    ): void => {
      const looksLikeRealId = REAL_KB_ID_PATTERN.test(value);
      if (looksLikeRealId) {
        if (knowledgeBaseNames.has(value)) {
          ctx.addIssue({
            code: "custom",
            message: `Connector target "${target.name}" ${fieldLabel} "${value}" looks like a literal KB ID but also matches a knowledgeBases[] entry. Rename the knowledge base or reference it by its project name instead.`,
          });
        }
      } else {
        if (!knowledgeBaseNames.has(value)) {
          ctx.addIssue({
            code: "custom",
            message: `Connector target "${target.name}" ${fieldLabel} "${value}" does not match any knowledgeBases[] entry. To wire an external KB that this project does not own, use its 10-character KB ID.`,
          });
        }
      }
    };
    for (const gateway of spec.agentCoreGateways ?? []) {
      for (const target of gateway.targets ?? []) {
        if (target.targetType !== "connector") continue;
        if (target.connectorId !== "bedrock-knowledge-bases") {
          continue;
        }
        for (const cfg of target.configurations ?? []) {
          const pv = cfg.parameterValues;
          if (
            cfg.name === "Retrieve" &&
            pv?.knowledgeBaseId &&
            typeof pv.knowledgeBaseId === "string"
          ) {
            validateKbReference(
              target,
              pv.knowledgeBaseId,
              "configurations[].parameterValues.knowledgeBaseId",
            );
          }
          if (cfg.name === "AgenticRetrieveStream") {
            const rawRetrievers = pv?.retrievers;
            if (!Array.isArray(rawRetrievers)) continue;
            for (const r of rawRetrievers) {
              if (!r || typeof r !== "object") continue;
              const kbId = (
                r as {
                  configuration?: {
                    knowledgeBase?: {
                      knowledgeBaseId?: string;
                    };
                  };
                }
              ).configuration?.knowledgeBase?.knowledgeBaseId;
              if (kbId)
                validateKbReference(
                  target,
                  kbId,
                  "configurations[].parameterValues.retrievers[].knowledgeBaseId",
                );
            }
          }
        }
      }
    }
    const credentialEnvironmentNames = new Map<string, string>();
    for (const [credentialIndex, credential] of spec.credentials.entries()) {
      for (const environmentName of credentialEnvironmentVariableNames(credential)) {
        const conflictingName = credentialEnvironmentNames.get(environmentName);
        if (conflictingName) {
          ctx.addIssue({
            code: "custom",
            message:
              `Credential "${credential.name}" and "${conflictingName}" derive the same environment variable "${environmentName}"; ` +
              "choose credential names that produce distinct environment variables",
            path: ["credentials", credentialIndex, "name"],
          });
        } else {
          credentialEnvironmentNames.set(environmentName, credential.name);
        }
      }
    }
    const paymentManagerEnvironmentNames = new Map<string, string>();
    for (const [paymentIndex, payment] of (spec.payments ?? []).entries()) {
      const environmentName = toEnvironmentName(payment.name);
      const conflictingName = paymentManagerEnvironmentNames.get(environmentName);
      if (conflictingName) {
        ctx.addIssue({
          code: "custom",
          message:
            `Payment managers "${payment.name}" and "${conflictingName}" derive the same payment manager environment name; ` +
            "choose names that differ by more than letter casing",
          path: ["payments", paymentIndex, "name"],
        });
      } else {
        paymentManagerEnvironmentNames.set(environmentName, payment.name);
      }

      for (const [connectorIndex, connector] of payment.connectors.entries()) {
        if (connector.provisionMode === "QUICK_CREATE") continue;

        const credential = spec.credentials.find((c) => c.name === connector.credentialName);
        if (!credential) {
          ctx.addIssue({
            code: "custom",
            message: `Payment connector "${connector.name}" in manager "${payment.name}" references credential "${connector.credentialName}" which does not exist in credentials[]`,
            path: ["payments", paymentIndex, "connectors", connectorIndex, "credentialName"],
          });
        } else if (credential.authorizerType !== "PaymentCredentialProvider") {
          ctx.addIssue({
            code: "custom",
            message: `Payment connector "${connector.name}" in manager "${payment.name}" references credential "${connector.credentialName}" which is a ${credential.authorizerType}, not a PaymentCredentialProvider`,
            path: ["payments", paymentIndex, "connectors", connectorIndex, "credentialName"],
          });
        } else if (credential.provider !== connector.provider) {
          ctx.addIssue({
            code: "custom",
            message:
              `Payment connector "${connector.name}" in manager "${payment.name}" uses provider "${connector.provider}", ` +
              `but credential "${connector.credentialName}" uses provider "${credential.provider}"`,
            path: ["payments", paymentIndex, "connectors", connectorIndex, "provider"],
          });
        }
      }
    }
  });
export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;
/** Containment needs a Box project, and a project holds one PRIVATE_VPC runtime for now. **/
function containmentIssues(spec: {
  projectType?: string;
  runtimes: { name: string; containment?: Containment }[];
}): { message: string; path: (string | number)[] }[] {
  const issues: { message: string; path: (string | number)[] }[] = [];
  spec.runtimes.forEach((runtime, index) => {
    if (runtime.containment !== undefined && !isBoxProject(spec)) {
      issues.push({
        message: `Runtime "${runtime.name}" sets containment, which requires "projectType": "box"`,
        path: ["runtimes", index, "containment"],
      });
    }
  });
  const contained = spec.runtimes.filter((runtime) => runtime.containment === "PRIVATE_VPC");
  if (contained.length > 1) {
    issues.push({
      message: `${PRIVATE_VPC_LIMIT} Found ${contained.map((runtime) => runtime.name).join(", ")}.`,
      path: ["runtimes"],
    });
  }
  return issues;
}
