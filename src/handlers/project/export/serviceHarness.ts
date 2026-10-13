import type {
  Harness,
  HarnessSkill as ApiHarnessSkill,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError, MalformedServiceResponseError } from "../../../errors";
import { HarnessSpecSchema, type HarnessSpec } from "../../../projectSchemas/harness";
import type { ExportNote } from "../../../core/project/templates/export";
import type { MemoryRetrievalConfig } from "./types";

export const SERVICE_FIELD_OMITTED_NOTE_CATEGORY = "Service harness field not exported";

function parseHarnessArn(arn: string): { region: string; harnessId: string } {
  const match = /^arn:[^:]+:bedrock-agentcore:([a-z0-9-]+):(\d{12}):harness\/([^/]+)$/.exec(arn);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new InputValidationError(
      `"${arn}" is not a valid harness ARN ` +
        "(expected arn:<partition>:bedrock-agentcore:<region>:<account>:harness/<id>)",
    );
  }
  return { region: match[1], harnessId: match[3] };
}

/** Extract the harness id from a validated harness ARN. */
export function harnessIdFromArn(arn: string): string {
  return parseHarnessArn(arn).harnessId;
}

/**
 * The region embedded in a harness ARN (`arn:<partition>:bedrock-agentcore:<region>:...`).
 * The harness lives in this region, so it takes precedence over the CLI's resolved
 * region for the export fetch.
 */
export function regionFromHarnessArn(arn: string): string {
  return parseHarnessArn(arn).region;
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
  notes: ExportNote[];
  /** Service model additionalParams, which the local harness spec only holds for lite_llm. */
  modelAdditionalParams?: Record<string, unknown>;
  memoryRetrievalConfig?: MemoryRetrievalConfig;
} {
  const notes: ExportNote[] = [];
  if (harness.hooks?.length) {
    notes.push({
      category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
      message: `${harness.hooks.length} source harness hook(s) were not exported. Reimplement them manually in the generated agent before relying on their behavior.`,
    });
  }
  const promptBlocks = harness.systemPrompt ?? [];
  const joinedPrompt = promptBlocks
    .map((block) => ("text" in block ? block.text : undefined))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
  const systemPrompt = joinedPrompt.length > 0 ? joinedPrompt : undefined;
  for (const block of promptBlocks) {
    if ("text" in block && typeof block.text === "string" && block.text.length > 0) continue;
    const unknown = unknownMemberName(block);
    notes.push({
      category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
      message:
        `A system prompt block${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
        "its service payload was unknown or incomplete.",
    });
  }

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
    skills: (harness.skills ?? [])
      .map((skill) => mapSkill(skill, notes))
      .filter((skill) => skill !== undefined),
    allowedTools: harness.allowedTools,
    memory: mapMemory(harness.memory, notes),
    maxIterations: harness.maxIterations ?? undefined,
    maxTokens: harness.maxTokens ?? undefined,
    timeoutSeconds: harness.timeoutSeconds ?? undefined,
    truncation: harness.truncation,
    containerUri: mapContainerUri(harness.environmentArtifact, notes),
    environmentVariables: harness.environmentVariables,
    // The harness's executionRoleArn is deliberately NOT carried: the exported
    // agent is a new runtime that gets its own CDK-managed execution role.
    ...mapRuntimeEnvironment(harness, notes),
  });

  const parsed = HarnessSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MalformedServiceResponseError(
      `The fetched harness cannot be expressed as a local harness spec:\n${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  const { bedrockModelConfig, openAiModelConfig, geminiModelConfig } = harness.model ?? {};
  const params = (bedrockModelConfig ?? openAiModelConfig ?? geminiModelConfig)?.additionalParams;
  const modelAdditionalParams =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined;
  return {
    spec: parsed.data,
    systemPrompt,
    notes,
    modelAdditionalParams,
    memoryRetrievalConfig: harness.memory?.agentCoreMemoryConfiguration?.retrievalConfig,
  };
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

/** Service skill union -> the flat local skill shape. */
function mapSkill(
  skill: ApiHarnessSkill,
  notes: ExportNote[],
): Record<string, unknown> | undefined {
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
  const unknown = unknownMemberName(skill);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `A harness skill${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "its service payload was unknown or incomplete.",
  });
  return undefined;
}

/**
 * Service memory union -> the local memory ref. A provisioned harness memory
 * (managed, with a service-populated ARN) is referenced by ARN like any
 * bring-your-own memory; managed-without-ARN keeps the `managed` marker so the
 * export mapper can emit its follow-up note.
 */
function mapMemory(
  memory: Harness["memory"],
  notes: ExportNote[],
): Record<string, unknown> | undefined {
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
  const unknown = unknownMemberName(memory);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `The harness memory configuration${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "the service payload was unknown or incomplete.",
  });
  return undefined;
}

/**
 * Runtime-environment block -> networkMode/networkConfig, lifecycleConfig, and
 * filesystem mounts. A VPC harness without explicit subnets/security groups
 * cannot be expressed locally; fail here — before anything is written — with a
 * clear message instead of a downstream schema error.
 */
function mapRuntimeEnvironment(harness: Harness, notes: ExportNote[]): Record<string, unknown> {
  if (harness.environment && !("agentCoreRuntimeEnvironment" in harness.environment)) {
    const unknown = unknownMemberName(harness.environment);
    notes.push({
      category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
      message:
        `The harness environment${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
        "the service payload is not an AgentCore Runtime environment.",
    });
    return {};
  }
  const env = harness.environment?.agentCoreRuntimeEnvironment;
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
    } else {
      const unknown = unknownMemberName(fs);
      notes.push({
        category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
        message:
          `A filesystem configuration${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
          "its service payload was unknown or incomplete.",
      });
    }
  }
  if (efs.length) out.efsAccessPoints = efs;
  if (s3.length) out.s3AccessPoints = s3;

  return out;
}

function mapContainerUri(
  artifact: Harness["environmentArtifact"],
  notes: ExportNote[],
): string | undefined {
  if (!artifact) return undefined;
  if ("containerConfiguration" in artifact) {
    return artifact.containerConfiguration?.containerUri;
  }
  const unknown = unknownMemberName(artifact);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `The harness environment artifact${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "the service payload is not a container configuration.",
  });
  return undefined;
}

function unknownMemberName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("$unknown" in value)) return undefined;
  const unknown = (value as { $unknown?: unknown }).$unknown;
  return Array.isArray(unknown) && typeof unknown[0] === "string" ? unknown[0] : undefined;
}

/** Drop undefined-valued keys so optional fields stay omitted. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
