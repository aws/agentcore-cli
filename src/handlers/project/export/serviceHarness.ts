import type {
  Harness,
  HarnessSkill as ApiHarnessSkill,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError, MalformedServiceResponseError } from "../../../errors";
import { HarnessSpecSchema, type HarnessSpec } from "../../../projectSchemas/harness";

/** Extract the harness id from a harness ARN (`.../harness/<id>` -> `<id>`). */
export function harnessIdFromArn(arn: string): string {
  const match = /:harness\/([^/]+)$/.exec(arn);
  if (!match?.[1]) {
    throw new InputValidationError(
      `"${arn}" is not a valid harness ARN (expected ...:harness/<id>)`,
    );
  }
  return match[1];
}

/**
 * The region embedded in a harness ARN (`arn:<partition>:bedrock-agentcore:<region>:...`),
 * or undefined when the ARN carries none. The harness lives in this region, so
 * it takes precedence over the CLI's resolved region for the export fetch.
 */
export function regionFromHarnessArn(arn: string): string | undefined {
  const match = /^arn:[^:]+:bedrock-agentcore:([a-z0-9-]+):/.exec(arn);
  return match?.[1] || undefined;
}

/**
 * Map a control-plane Harness (GetHarness response) onto the local
 * {@link HarnessSpecSchema} shape, so the `--arn` path feeds the export mapper
 * exactly like an in-project harness. Throws when the payload cannot be
 * expressed as a valid local spec.
 */
export function mapServiceHarnessToSpec(harness: Harness): {
  spec: HarnessSpec;
  systemPrompt?: string;
} {
  const joinedPrompt = (harness.systemPrompt ?? [])
    .map((block) => ("text" in block ? block.text : undefined))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
  const systemPrompt = joinedPrompt.length > 0 ? joinedPrompt : undefined;

  const candidate = clean({
    name: harness.harnessName,
    model: mapModel(harness.model),
    tools: (harness.tools ?? []).map((tool) =>
      clean({
        type: tool.type,
        name: tool.name ?? tool.type,
        config: tool.config,
      }),
    ),
    skills: (harness.skills ?? []).map(mapSkill).filter((skill) => skill !== undefined),
    allowedTools: harness.allowedTools,
    memory: mapMemory(harness.memory),
    maxIterations: harness.maxIterations ?? undefined,
    maxTokens: harness.maxTokens ?? undefined,
    timeoutSeconds: harness.timeoutSeconds ?? undefined,
    truncation: harness.truncation,
    containerUri: harness.environmentArtifact?.containerConfiguration?.containerUri,
    environmentVariables: harness.environmentVariables,
    // The harness's executionRoleArn is deliberately NOT carried: the exported
    // agent is a new runtime that gets its own CDK-managed execution role.
    ...mapRuntimeEnvironment(harness),
  });

  const parsed = HarnessSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MalformedServiceResponseError(
      `The fetched harness cannot be expressed as a local harness spec:\n${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return { spec: parsed.data, systemPrompt };
}

function mapModel(model: Harness["model"]): Record<string, unknown> {
  if (model?.bedrockModelConfig) {
    const c = model.bedrockModelConfig;
    return clean({
      provider: "bedrock",
      modelId: c.modelId,
      apiFormat: c.apiFormat,
      temperature: c.temperature,
      topP: c.topP,
      maxTokens: c.maxTokens,
    });
  }
  if (model?.openAiModelConfig) {
    const c = model.openAiModelConfig;
    return clean({
      provider: "open_ai",
      modelId: c.modelId,
      apiKeyArn: c.apiKeyArn,
      apiFormat: c.apiFormat,
      temperature: c.temperature,
      topP: c.topP,
      maxTokens: c.maxTokens,
    });
  }
  if (model?.geminiModelConfig) {
    const c = model.geminiModelConfig;
    return clean({
      provider: "gemini",
      modelId: c.modelId,
      apiKeyArn: c.apiKeyArn,
      temperature: c.temperature,
      topP: c.topP,
      topK: c.topK,
      maxTokens: c.maxTokens,
    });
  }
  if (model?.liteLlmModelConfig) {
    const c = model.liteLlmModelConfig;
    return clean({
      provider: "lite_llm",
      modelId: c.modelId,
      apiKeyArn: c.apiKeyArn,
      apiBase: c.apiBase,
      temperature: c.temperature,
      topP: c.topP,
      maxTokens: c.maxTokens,
      additionalParams: c.additionalParams,
    });
  }
  throw new MalformedServiceResponseError(
    "The fetched harness has no recognized model configuration.",
  );
}

/** Service skill union -> the flat local skill shape; unknown members are dropped. */
function mapSkill(skill: ApiHarnessSkill): Record<string, unknown> | undefined {
  if ("path" in skill && skill.path) return { path: skill.path };
  if ("s3" in skill && skill.s3?.uri) return { s3Uri: skill.s3.uri };
  if ("git" in skill && skill.git?.url) {
    const { url, path, auth } = skill.git;
    return clean({
      gitUrl: url,
      path,
      auth: auth?.credentialArn
        ? clean({ credentialArn: auth.credentialArn, username: auth.username })
        : undefined,
    });
  }
  if ("awsSkills" in skill && skill.awsSkills) {
    return { awsSkills: clean({ paths: skill.awsSkills.paths }) };
  }
  return undefined;
}

/**
 * Service memory union -> the local memory ref. A provisioned harness memory
 * (managed, with a service-populated ARN) is referenced by ARN like any
 * bring-your-own memory; managed-without-ARN keeps the `managed` marker so the
 * export mapper can emit its follow-up note.
 */
function mapMemory(memory: Harness["memory"]): Record<string, unknown> | undefined {
  if (!memory) return undefined;
  if ("agentCoreMemoryConfiguration" in memory && memory.agentCoreMemoryConfiguration?.arn) {
    const { arn, actorId, messagesCount } = memory.agentCoreMemoryConfiguration;
    return clean({ mode: "existing", arn, actorId, messagesCount });
  }
  if ("managedMemoryConfiguration" in memory && memory.managedMemoryConfiguration) {
    const arn = memory.managedMemoryConfiguration.arn;
    if (arn) return { mode: "existing", arn };
    return { mode: "managed" };
  }
  if ("disabled" in memory && memory.disabled) return { mode: "disabled" };
  return undefined;
}

/**
 * Runtime-environment block -> networkMode/networkConfig, lifecycleConfig, and
 * filesystem mounts. A VPC harness without explicit subnets/security groups
 * cannot be expressed locally; fail here — before anything is written — with a
 * clear message instead of a downstream schema error.
 */
function mapRuntimeEnvironment(harness: Harness): Record<string, unknown> {
  const env =
    harness.environment && "agentCoreRuntimeEnvironment" in harness.environment
      ? harness.environment.agentCoreRuntimeEnvironment
      : undefined;
  if (!env) return {};
  const out: Record<string, unknown> = {};

  const net = env.networkConfiguration;
  if (net?.networkMode === "VPC") {
    const subnets = net.networkModeConfig?.subnets;
    const securityGroups = net.networkModeConfig?.securityGroups;
    if (!subnets?.length || !securityGroups?.length) {
      throw new InputValidationError(
        "This harness runs in a VPC but its network configuration is missing explicit subnets " +
          "and/or security groups, which the exported agent requires. Re-create the harness with " +
          "explicit VPC subnets and security groups, or export a non-VPC harness.",
      );
    }
    out.networkMode = "VPC";
    out.networkConfig = { subnets, securityGroups };
  }

  const lifecycle = env.lifecycleConfiguration;
  if (lifecycle && (lifecycle.idleRuntimeSessionTimeout != null || lifecycle.maxLifetime != null)) {
    out.lifecycleConfig = clean({
      idleRuntimeSessionTimeout: lifecycle.idleRuntimeSessionTimeout ?? undefined,
      maxLifetime: lifecycle.maxLifetime ?? undefined,
    });
  }

  const efs: { accessPointArn: string; mountPath: string }[] = [];
  const s3: { accessPointArn: string; mountPath: string }[] = [];
  for (const fs of env.filesystemConfigurations ?? []) {
    if ("sessionStorage" in fs && fs.sessionStorage?.mountPath) {
      out.sessionStoragePath = fs.sessionStorage.mountPath;
    } else if (
      "efsAccessPoint" in fs &&
      fs.efsAccessPoint?.accessPointArn &&
      fs.efsAccessPoint.mountPath
    ) {
      efs.push({
        accessPointArn: fs.efsAccessPoint.accessPointArn,
        mountPath: fs.efsAccessPoint.mountPath,
      });
    } else if (
      "s3FilesAccessPoint" in fs &&
      fs.s3FilesAccessPoint?.accessPointArn &&
      fs.s3FilesAccessPoint.mountPath
    ) {
      s3.push({
        accessPointArn: fs.s3FilesAccessPoint.accessPointArn,
        mountPath: fs.s3FilesAccessPoint.mountPath,
      });
    }
  }
  if (efs.length) out.efsAccessPoints = efs;
  if (s3.length) out.s3AccessPoints = s3;

  return out;
}

/** Drop undefined-valued keys so optional fields stay omitted. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
