import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import type { Harness } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../errors";
import {
  HARNESS_MODEL_CONFIG_KEYS,
  type HarnessSkill,
  type HarnessSpec,
} from "../../../projectSchemas/harness";
import type { HarnessFiles } from "../../project/fsUtils";
import { sseData } from "../inspector/respond";

const FILESYSTEMS = "environment.agentCoreRuntimeEnvironment.filesystemConfigurations";
const UNSUPPORTED_FIELDS = {
  containerUri: "environmentArtifact",
  dockerfile: "dockerfile",
  efsAccessPoints: `${FILESYSTEMS} efsAccessPoint`,
  s3AccessPoints: `${FILESYSTEMS} s3FilesAccessPoint`,
} as const;

export const HarnessInvokeBodySchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  harnessOverrides: z
    .object({
      model: z.record(z.string(), z.unknown()).optional(),
      systemPrompt: z.string().optional(),
      skills: z.array(z.record(z.string(), z.unknown())).optional(),
      allowedTools: z.array(z.string()).optional(),
      actorId: z.string().optional(),
      maxIterations: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      timeoutSeconds: z.number().int().positive().optional(),
    })
    .optional(),
});

export type HarnessInvokeRequest = z.infer<typeof HarnessInvokeBodySchema>;

export async function* harnessEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<InvokeHarnessStreamOutput> {
  for await (const data of sseData(body)) {
    yield (JSON.parse(data) as { event: InvokeHarnessStreamOutput }).event;
  }
}
type ContainerRequest = { body: Record<string, unknown>; apiKey: boolean };

export function assertLocalSupported(name: string, spec: HarnessSpec): void {
  const field = (Object.keys(UNSUPPORTED_FIELDS) as (keyof typeof UNSUPPORTED_FIELDS)[]).find(
    (key) => {
      const value = spec[key];
      return Array.isArray(value) ? value.length > 0 : value !== undefined;
    },
  );
  if (field) {
    throw new InputValidationError(
      `Harness '${name}' sets '${UNSUPPORTED_FIELDS[field]}', which local dev does not support yet. Remove it to run locally, or deploy the harness.`,
    );
  }
}

export function omittedReferences(files: HarnessFiles, deployed: Harness | undefined): string[] {
  return resolveReferences(files.spec, deployed, undefined).omitted;
}

export function toContainerRequest(
  files: HarnessFiles,
  deployed: Harness | undefined,
  request: HarnessInvokeRequest,
): ContainerRequest {
  const { spec } = files;
  const overrides = request.harnessOverrides ?? {};
  const model = overrides.model ?? toWireModel(spec.model);
  const systemPrompt = overrides.systemPrompt ?? files.systemPrompt;
  const { memoryConfig, skills } = resolveReferences(spec, deployed, overrides.actorId);
  const body = {
    operation: "invoke",
    featureFlags: {},
    ...(memoryConfig && { memoryConfig }),
    ...(spec.truncation && { truncation: spec.truncation }),
    ...(deployed?.arn && { harnessArn: deployed.arn }),
    invokePayload: {
      model,
      ...(systemPrompt && { systemPrompt: [{ text: systemPrompt }] }),
      tools: spec.tools,
      allowedTools: overrides.allowedTools ?? spec.allowedTools,
      messages: [{ role: "user", content: [{ text: request.prompt }] }],
      maxIterations: overrides.maxIterations ?? spec.maxIterations,
      maxTokens: overrides.maxTokens ?? spec.maxTokens,
      timeoutSeconds: overrides.timeoutSeconds ?? spec.timeoutSeconds,
      skills: overrides.skills ?? skills,
    },
  };
  return { body, apiKey: usesApiKey(model) };
}

function resolveReferences(
  spec: HarnessSpec,
  deployed: Harness | undefined,
  actorId: string | undefined,
): {
  memoryConfig?: Record<string, unknown>;
  skills: Record<string, unknown>[];
  omitted: string[];
} {
  const omitted: string[] = [];
  const memoryConfig = toMemoryConfig(spec.memory, deployed, actorId, omitted);
  const skills = spec.skills.flatMap((skill) => toWireSkill(skill, deployed, omitted));
  return { memoryConfig, skills, omitted };
}

function toWireModel(model: HarnessSpec["model"]): Record<string, unknown> {
  const { provider, ...config } = model;
  return { [HARNESS_MODEL_CONFIG_KEYS[provider]]: config };
}

function usesApiKey(model: Record<string, unknown>): boolean {
  return Object.values(model).some((config) =>
    Boolean((config as { apiKeyArn?: string }).apiKeyArn),
  );
}

function toWireSkill(
  skill: HarnessSkill,
  deployed: Harness | undefined,
  omitted: string[],
): Record<string, unknown>[] {
  if ("s3Uri" in skill) return [{ s3: { uri: skill.s3Uri } }];
  if (!("gitUrl" in skill)) return [skill];
  if (!skill.auth?.credentialName) {
    return [{ git: { url: skill.gitUrl, path: skill.path, auth: skill.auth } }];
  }
  const match = deployed?.skills?.find((candidate) => candidate.git?.url === skill.gitUrl);
  if (match) return [{ git: match.git }];
  omitted.push(`git skill ${skill.gitUrl}`);
  return [];
}

function toMemoryConfig(
  memory: HarnessSpec["memory"],
  deployed: Harness | undefined,
  actorId: string | undefined,
  omitted: string[],
): Record<string, unknown> | undefined {
  if (!memory || memory.mode === "disabled") return undefined;
  if (memory.mode === "existing" && memory.arn) {
    return {
      agentCoreMemoryConfiguration: {
        arn: memory.arn,
        actorId: actorId ?? memory.actorId,
        messagesCount: memory.messagesCount,
      },
    };
  }
  const resolved =
    deployed?.memory?.agentCoreMemoryConfiguration ??
    (deployed?.memory?.managedMemoryConfiguration?.arn
      ? { arn: deployed.memory.managedMemoryConfiguration.arn }
      : undefined);
  if (!resolved) {
    omitted.push("memory");
    return undefined;
  }
  return { agentCoreMemoryConfiguration: { ...resolved, ...(actorId && { actorId }) } };
}
