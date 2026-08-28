import { isReservedProjectName } from "./constants";
import { ProjectRuntimeSchema } from "./runtime";
import {
  AgentCoreGatewaySchema,
  AgentCoreGatewayTargetSchema,
  AgentCoreMcpRuntimeToolSchema,
  REAL_KB_ID_PATTERN,
} from "./gateway";
import { ABTestSchema } from "./ab-test";
import { ConfigBundleSchema } from "./config-bundle";
import { CredentialSchema, credentialEnvironmentVariableNames } from "./credential";
import { DatasetSchema } from "./dataset";
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
    $schema: z.string().optional(),
    name: ProjectNameSchema,
    version: z.number().int().min(1),
    managedBy: ManagedBySchema,
    tags: TagsSchema.optional(),
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
    mcpRuntimeTools: z
      .array(AgentCoreMcpRuntimeToolSchema)
      .optional()
      .superRefine(uniqueNames("MCP runtime tool")),
    unassignedTargets: z
      .array(AgentCoreGatewayTargetSchema)
      .optional()
      .superRefine(uniqueNames("unassigned target")),
    policyEngines: z
      .array(PolicyEngineSchema)
      .default([])
      .superRefine(uniqueNames("policy engine")),
    configBundles: z
      .array(ConfigBundleSchema)
      .default([])
      .superRefine(uniqueNames("config bundle")),
    abTests: z.array(ABTestSchema).default([]).superRefine(uniqueNames("AB test")),
    harnesses: z.array(HarnessRegistryEntrySchema).default([]).superRefine(uniqueNames("harness")),
    datasets: z.array(DatasetSchema).optional().superRefine(uniqueNames("dataset")),
    httpGateways: z
      .array(z.unknown())
      .max(
        0,
        '"httpGateways" is deprecated. Migrate to agentCoreGateways with protocolType: "None", or use "agentcore import gateway".',
      )
      .optional(),
    payments: z.array(PaymentManagerSchema).optional().superRefine(uniqueNames("payment manager")),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const agentNames = new Set(spec.runtimes.map((a) => a.name));
    const evaluatorNames = new Set(spec.evaluators.map((e) => e.name));
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
    for (const test of spec.abTests ?? []) {
      const gwField = test.gatewayRef;
      if (gwField && typeof gwField === "string") {
        const match = /^\{\{gateway:(.+)\}\}$/.exec(gwField);
        if (match) {
          const gwName = match[1];
          const gwExists = (spec.agentCoreGateways ?? []).some((gw) => gw.name === gwName);
          if (!gwExists) {
            ctx.addIssue({
              code: "custom",
              message: `AB test "${test.name}" references gateway "${gwName}" which does not exist in agentCoreGateways`,
            });
          }
          if (test.mode === "target-based") {
            const gw = (spec.agentCoreGateways ?? []).find((g) => g.name === gwName);
            if (gw) {
              const gwTargetNames = new Set((gw.targets ?? []).map((t) => t.name));
              for (const variant of test.variants) {
                const targetName = variant.variantConfiguration.target?.targetName;
                if (targetName && !gwTargetNames.has(targetName)) {
                  ctx.addIssue({
                    code: "custom",
                    message: `AB test "${test.name}" variant "${variant.name}" references target "${targetName}" which does not exist in gateway "${gwName}" targets`,
                  });
                }
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
