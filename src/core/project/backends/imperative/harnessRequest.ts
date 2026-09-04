import type { DocumentType } from "@smithy/types";
import type {
  AuthorizerConfiguration,
  CreateHarnessRequest,
  CustomJWTAuthorizerConfiguration,
  FilesystemConfiguration,
  HarnessEnvironmentProviderRequest,
  HarnessMemoryConfiguration,
  HarnessModelConfiguration,
  HarnessSkill as ServiceHarnessSkill,
  HarnessTool as ServiceHarnessTool,
  UpdateHarnessRequest,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectStateError } from "../../../../errors/errors";
import type { HarnessSkill, HarnessSpec } from "../../../../projectSchemas/harness";
import { hashOf } from "./hash";

// The local harness spec -> service request mapping. This is the inverse of
// mapServiceHarnessToSpec (src/handlers/project/export/serviceHarness.ts); the
// two are held together by a round-trip test so a field added to one side
// cannot silently go missing on the other.

/**
 * Rejects spec fields the imperative path cannot honour, before any AWS call.
 * Each reason names the field and says why, and every offending field is
 * listed at once so the user fixes the spec in one pass.
 */
export function validateForImperativeDeploy(spec: HarnessSpec): void {
  const problems: string[] = [];
  if (spec.dockerfile !== undefined) {
    problems.push(
      "'dockerfile': building a container image needs the CodeBuild pipeline the CDK path " +
        "provisions; use 'containerUri' with a prebuilt image, or deploy without the flag.",
    );
  }
  spec.skills.forEach((skill, index) => {
    if ("path" in skill) {
      problems.push(
        `'skills[${index}]' (path '${skill.path}'): a path-based skill has to be baked into a ` +
          "container image; put the skill in the harness's skills/ directory, or use an s3Uri, " +
          "gitUrl, or awsSkills source.",
      );
    }
    if ("gitUrl" in skill && skill.auth?.credentialName !== undefined) {
      problems.push(
        `'skills[${index}].auth.credentialName': the service takes a credential ARN; ` +
          "use 'credentialArn' instead.",
      );
    }
  });
  if (spec.memory?.mode === "existing" && spec.memory.arn === undefined) {
    problems.push(
      `'memory.name' ('${spec.memory.name}'): a harness-only project has no memory resource to ` +
        "resolve the name against; reference the memory by 'arn'.",
    );
  }
  if (problems.length > 0) {
    throw new ProjectStateError(
      `Harness '${spec.name}' uses ${problems.length === 1 ? "a field" : "fields"} the ` +
        `imperative deploy does not support:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "Unset AGENTCORE_CLI_EXPERIMENTAL_IMPERATIVE_DEPLOY to deploy through CDK instead.",
    );
  }
}

/** Drop undefined-valued keys so optional fields stay omitted from the wire. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function mapModel(model: HarnessSpec["model"]): HarnessModelConfiguration {
  const { provider, modelId, apiKeyArn, apiFormat, temperature, topP, topK, maxTokens } = model;
  const { apiBase, additionalParams } = model;
  const shared = {
    modelId,
    temperature,
    topP,
    maxTokens,
    // A JSON object is a document; the local schema's record type is narrower than Smithy's.
    additionalParams: additionalParams as DocumentType | undefined,
  };
  switch (provider) {
    case "bedrock":
      return { bedrockModelConfig: clean({ ...shared, apiFormat }) };
    case "open_ai":
      return {
        openAiModelConfig: clean({
          ...shared,
          apiKeyArn,
          // The schema keeps converse_stream off open_ai, so the narrowing holds.
          apiFormat: apiFormat as "responses" | "chat_completions" | undefined,
        }),
      };
    case "gemini":
      return { geminiModelConfig: clean({ ...shared, apiKeyArn, topK }) };
    case "lite_llm":
      return { liteLlmModelConfig: clean({ ...shared, apiKeyArn, apiBase }) };
  }
}

/** The flat local skill union -> the service's nested one. */
export function mapSkill(skill: HarnessSkill): ServiceHarnessSkill {
  if ("s3Uri" in skill) return { s3: { uri: skill.s3Uri } };
  if ("awsSkills" in skill) return { awsSkills: clean({ paths: skill.awsSkills.paths }) };
  if ("gitUrl" in skill) {
    return {
      git: clean({
        url: skill.gitUrl,
        path: skill.path,
        auth: skill.auth?.credentialArn
          ? clean({ credentialArn: skill.auth.credentialArn, username: skill.auth.username })
          : undefined,
      }),
    };
  }
  return { path: skill.path };
}

function mapTool(tool: HarnessSpec["tools"][number]): ServiceHarnessTool {
  // The local config keys are the service's member names; the gateway config
  // is passthrough locally, which the cast tolerates.
  return clean({
    type: tool.type,
    name: tool.name,
    config: tool.config as ServiceHarnessTool["config"],
  });
}

function mapMemory(memory: HarnessSpec["memory"]): HarnessMemoryConfiguration {
  // An omitted memory block makes the service auto-provision a managed memory,
  // which is not what "no memory config" means anywhere else in the CLI: the
  // CDK construct emits Disabled for an omitted block, and so does this path.
  if (!memory) return { disabled: {} };
  switch (memory.mode) {
    case "disabled":
      return { disabled: {} };
    case "managed":
      return {
        managedMemoryConfiguration: clean({
          strategies: memory.strategies,
          eventExpiryDuration: memory.eventExpiryDuration,
          encryptionKeyArn: memory.encryptionKeyArn,
        }),
      };
    case "existing":
      // A by-name reference is rejected by validateForImperativeDeploy, so arn
      // is present here; the schema keeps retrievalConfig off by-arn references.
      return {
        agentCoreMemoryConfiguration: clean({
          arn: memory.arn!,
          actorId: memory.actorId,
          messagesCount: memory.messagesCount,
        }),
      };
  }
}

function mapEnvironment(spec: HarnessSpec): HarnessEnvironmentProviderRequest | undefined {
  const filesystems: FilesystemConfiguration[] = [
    ...(spec.sessionStoragePath
      ? [{ sessionStorage: { mountPath: spec.sessionStoragePath } }]
      : []),
    ...(spec.efsAccessPoints ?? []).map(({ accessPointArn, mountPath }) => ({
      efsAccessPoint: { accessPointArn, mountPath },
    })),
    ...(spec.s3AccessPoints ?? []).map(({ accessPointArn, mountPath }) => ({
      s3FilesAccessPoint: { accessPointArn, mountPath },
    })),
  ];
  const networkConfiguration = spec.networkMode
    ? clean({
        networkMode: spec.networkMode,
        networkModeConfig: spec.networkConfig
          ? {
              subnets: spec.networkConfig.subnets,
              securityGroups: spec.networkConfig.securityGroups,
            }
          : undefined,
      })
    : undefined;
  const lifecycleConfiguration = spec.lifecycleConfig
    ? clean({ ...spec.lifecycleConfig })
    : undefined;
  if (!networkConfiguration && !lifecycleConfiguration && filesystems.length === 0) {
    return undefined;
  }
  return {
    agentCoreRuntimeEnvironment: clean({
      networkConfiguration,
      lifecycleConfiguration,
      filesystemConfigurations: filesystems.length > 0 ? filesystems : undefined,
    }),
  };
}

function mapAuthorizer(spec: HarnessSpec): AuthorizerConfiguration | undefined {
  const jwt = spec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwt) return undefined;
  // Same field names on both sides apart from the member's casing.
  return { customJWTAuthorizer: clean({ ...jwt }) as unknown as CustomJWTAuthorizerConfiguration };
}

/**
 * The full desired configuration of a harness as a CreateHarnessRequest.
 * `extraSkills` are appended after the spec's own so the order — and therefore
 * the request hash — is stable: harness.json order first, then the caller's.
 */
export function buildCreateHarnessRequest(
  spec: HarnessSpec,
  systemPrompt: string,
  executionRoleArn: string,
  extraSkills: ServiceHarnessSkill[] = [],
): CreateHarnessRequest {
  return clean({
    harnessName: spec.name,
    executionRoleArn,
    model: mapModel(spec.model),
    systemPrompt: [{ text: systemPrompt }],
    tools: spec.tools.map(mapTool),
    skills: [...spec.skills.map(mapSkill), ...extraSkills],
    allowedTools: spec.allowedTools,
    memory: mapMemory(spec.memory),
    truncation: spec.truncation,
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens,
    timeoutSeconds: spec.timeoutSeconds,
    environmentVariables: spec.environmentVariables,
    environment: mapEnvironment(spec),
    environmentArtifact: spec.containerUri
      ? { containerConfiguration: { containerUri: spec.containerUri } }
      : undefined,
    authorizerConfiguration: mapAuthorizer(spec),
    tags: spec.tags,
  });
}

/**
 * The same configuration as an UpdateHarnessRequest. UpdateHarness has PATCH
 * semantics — an omitted field is retained — so the collections the spec owns
 * (tools, skills, allowed tools, environment variables) are always sent, even
 * when empty, and the optional-value wrappers are sent with no value when the
 * spec dropped the field. Either way the service ends up matching the spec.
 */
export function buildUpdateHarnessRequest(
  harnessId: string,
  spec: HarnessSpec,
  systemPrompt: string,
  executionRoleArn: string,
  extraSkills: ServiceHarnessSkill[] = [],
): UpdateHarnessRequest {
  const create = buildCreateHarnessRequest(spec, systemPrompt, executionRoleArn, extraSkills);
  const { harnessName: _name, tags: _tags, ...body } = create;
  return clean({
    ...body,
    harnessId,
    tools: body.tools ?? [],
    skills: body.skills ?? [],
    allowedTools: body.allowedTools ?? [],
    environmentVariables: body.environmentVariables ?? {},
    memory: { optionalValue: body.memory },
    environmentArtifact: { optionalValue: body.environmentArtifact },
    authorizerConfiguration: { optionalValue: body.authorizerConfiguration },
  });
}

/**
 * The identity of a desired configuration: a hash of the create request with
 * the per-attempt client token left out. Recorded after a harness reaches
 * READY and compared on the next deploy, so an unchanged spec issues no call.
 */
export function harnessRequestHash(request: CreateHarnessRequest): string {
  const { clientToken: _token, ...body } = request;
  return hashOf(body);
}
