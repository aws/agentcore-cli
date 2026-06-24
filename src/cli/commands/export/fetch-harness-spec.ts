import { ValidationError } from '../../../lib/errors/types';
import type { HarnessSpec } from '../../../schema';
import type {
  HarnessSkill as ApiHarnessSkill,
  HarnessTool as ApiHarnessTool,
  Harness,
  HarnessAgentCoreRuntimeEnvironment,
  HarnessModelConfiguration,
} from '../../aws/agentcore-harness';
import { getHarness } from '../../aws/agentcore-harness';

/**
 * Fetch a harness by ARN from the control plane and map it to a local HarnessSpec — the same
 * shape `resolveHarnessContext` produces for an in-project harness. This is the source path for
 * exporting a harness that was created OUTSIDE this CLI project (`--arn`): with no deployed
 * state, every resource it references is external and becomes a connection at mapping time.
 */
export async function fetchHarnessSpecByArn(
  arn: string,
  region: string
): Promise<{ spec: HarnessSpec; systemPrompt?: string }> {
  const harnessId = harnessIdFromArn(arn);
  const { harness } = await getHarness({ region, harnessId });
  return mapApiHarnessToSpec(harness);
}

/** Extract the harness id from a harness ARN (`.../harness/<id>` -> `<id>`). */
export function harnessIdFromArn(arn: string): string {
  const match = /:harness\/([^/]+)$/.exec(arn);
  if (!match?.[1]) {
    throw new ValidationError(`"${arn}" is not a valid harness ARN (expected …:harness/<id>).`);
  }
  return match[1];
}

/** Map a control-plane Harness (API shape) to the local HarnessSpec shape. */
export function mapApiHarnessToSpec(harness: Harness): { spec: HarnessSpec; systemPrompt?: string } {
  const model = mapModel(harness.model);
  const joinedPrompt = harness.systemPrompt?.map(b => b.text).join('\n');
  const systemPrompt = joinedPrompt && joinedPrompt.length > 0 ? joinedPrompt : undefined;

  const spec: HarnessSpec = {
    name: harness.harnessName,
    model,
    ...(systemPrompt ? { systemPrompt } : {}),
    tools: (harness.tools ?? []).map(mapTool),
    skills: (harness.skills ?? []).map(mapSkill),
    ...(harness.allowedTools ? { allowedTools: harness.allowedTools } : {}),
    ...(() => {
      const memory = harness.memory ? mapMemory(harness.memory) : undefined;
      return memory ? { memory } : {};
    })(),
    ...(harness.maxIterations != null ? { maxIterations: harness.maxIterations } : {}),
    ...(harness.maxTokens != null ? { maxTokens: harness.maxTokens } : {}),
    ...(harness.timeoutSeconds != null ? { timeoutSeconds: harness.timeoutSeconds } : {}),
    ...(harness.environmentArtifact?.containerConfiguration?.containerUri
      ? { containerUri: harness.environmentArtifact.containerConfiguration.containerUri }
      : {}),
    // NOTE: deliberately do NOT carry the harness's executionRoleArn. The exported agent is a NEW,
    // independent runtime (a different resource in a different project) — it must get its own
    // CDK-managed execution role so the construct can attach the runtime baseline (Bedrock, ECR
    // pull for Container builds, logs), the connection grants, and additionalPolicies. Reusing the
    // harness's role (imported → { mutable: false }) means CDK can't attach any of those, and the
    // Container runtime fails ECR-URI validation at deploy.
    ...(harness.environmentVariables ? { environmentVariables: harness.environmentVariables } : {}),
    ...(harness.tags ? { tags: harness.tags } : {}),
    // Conversation-truncation strategy. The control-plane shape matches the local schema 1:1.
    ...(harness.truncation ? { truncation: harness.truncation } : {}),
    // Runtime-environment config (network mode/VPC, lifecycle, filesystem mounts) lives under
    // environment.agentCoreRuntimeEnvironment in the GetHarness response.
    ...mapRuntimeEnvironment(harness.environment?.agentCoreRuntimeEnvironment),
  } as HarnessSpec;

  return { spec, systemPrompt };
}

function mapModel(model: HarnessModelConfiguration | undefined): HarnessSpec['model'] {
  if (model?.bedrockModelConfig) {
    const c = model.bedrockModelConfig;
    return clean({
      provider: 'bedrock',
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
      provider: 'open_ai',
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
      provider: 'gemini',
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
      provider: 'lite_llm',
      modelId: c.modelId,
      apiKeyArn: c.apiKeyArn,
      apiBase: c.apiBase,
      temperature: c.temperature,
      topP: c.topP,
      maxTokens: c.maxTokens,
      additionalParams: c.additionalParams,
    });
  }
  throw new ValidationError('Fetched harness has no recognized model configuration.');
}

function mapTool(tool: ApiHarnessTool): HarnessSpec['tools'][number] {
  // The API tool shape (type/name/config) lines up with the local HarnessToolSchema; pass it
  // through, dropping undefined keys. Browser/code-interpreter ARNs live nested in config
  // (config.agentCoreBrowser.browserArn etc.) and are carried by the config spread.
  return clean({
    type: tool.type,
    name: tool.name,
    ...(tool.config ? { config: tool.config } : {}),
  }) as HarnessSpec['tools'][number];
}

/** Git-skill auth as returned by GetHarness. */
interface GitAuthShape {
  credentialArn?: string;
  username?: string;
}

/**
 * Normalize a control-plane skill into the local HarnessSpec skill shape.
 *
 * The service returns skills in the structured CFN/control-plane form — S3: `{ S3: { Uri } }`,
 * Git: `{ Git: { Url, Path?, ... } }`, Path: `{ Path: ... }` — whereas the local spec uses
 * `{ s3Uri }` / `{ gitUrl, path? }` / `{ path }`. Passing the raw API shape through would leave
 * S3/git skills undetected by isS3Skill/isGitSkill in the export mapper (so an S3 skill would
 * silently skip its generated additionalPolicies). Handle both the structured (PascalCase) form
 * and the already-lowercased form defensively.
 */
function mapSkill(skill: ApiHarnessSkill): HarnessSpec['skills'][number] {
  const s = skill as Record<string, unknown>;

  // S3: { S3: { Uri } } | { s3Uri }
  const s3 = (s.S3 ?? s.s3) as { Uri?: string; uri?: string } | undefined;
  const s3Uri = s3?.Uri ?? s3?.uri ?? (s.s3Uri as string | undefined);
  if (s3Uri) return { s3Uri };

  // Git: { Git: { Url, Path?, Auth? } } | { git: { url, path?, auth? } } | { gitUrl, path?, auth? }
  const git = (s.Git ?? s.git) as
    | { Url?: string; url?: string; Path?: string; path?: string; Auth?: GitAuthShape; auth?: GitAuthShape }
    | undefined;
  const gitUrl = git?.Url ?? git?.url ?? (s.gitUrl as string | undefined);
  if (gitUrl) {
    const path = git?.Path ?? git?.path ?? (s.path as string | undefined);
    // Private-repo auth: the control plane returns auth.credentialArn (a token-vault provider ARN);
    // the local spec stores it as auth.credentialName (the runtime extracts the provider name from
    // either form). Without carrying this, an exported --arn private git skill would clone anonymously.
    const rawAuth = git?.Auth ?? git?.auth ?? (s.auth as GitAuthShape | undefined);
    const credentialName = rawAuth?.credentialArn;
    const out: { gitUrl: string; path?: string; auth?: { credentialName: string; username?: string } } = { gitUrl };
    if (path) out.path = path;
    if (credentialName) {
      out.auth = rawAuth?.username ? { credentialName, username: rawAuth.username } : { credentialName };
    }
    return out as HarnessSpec['skills'][number];
  }

  // Path: { Path } | { path }
  const path = (s.Path as string | undefined) ?? (s.path as string | undefined);
  if (path) return { path };

  // Unknown shape — pass through (best effort; export will surface anything it can't map).
  return skill as HarnessSpec['skills'][number];
}

/**
 * Map the control-plane harness memory onto the local HarnessSpec memory ref. The service memory is
 * a tagged union; we handle each variant defensively because the CLI's bundled SDK model may lag the
 * service (an unmodeled variant arrives as `{ SDK_UNKNOWN_MEMBER: { name } }`):
 *   - agentCoreMemoryConfiguration -> existing (bring-your-own, by arn)
 *   - managedMemoryConfiguration   -> existing BY ARN when the harness-owned memory has been
 *       provisioned (it has a concrete, service-populated arn once the harness is READY); the
 *       exported agent references it like any external memory (connection + IAM scoped to the arn).
 *       When no arn is present yet (managed-but-unprovisioned, or an SDK-unknown variant) it returns
 *       `{ mode: 'managed' }`, which the downstream wiring does NOT resolve — so that case currently
 *       yields no memory on the exported agent. This is acceptable only because a READY harness
 *       always carries the arn and so takes the existing-by-arn path above.
 *   - anything else / unknown      -> undefined (omit memory; the exported agent gets none)
 */
function mapMemory(memory: NonNullable<Harness['memory']>): NonNullable<HarnessSpec['memory']> | undefined {
  const m = memory.agentCoreMemoryConfiguration;
  if (m?.arn) {
    return clean({
      mode: 'existing',
      arn: m.arn,
      actorId: m.actorId,
      messagesCount: m.messagesCount,
    }) as NonNullable<HarnessSpec['memory']>;
  }

  // Managed memory the harness created and owns. Once READY it carries a real ARN, so reference it
  // by ARN exactly like a bring-your-own memory — the export then wires it as an external memory
  // connection (IAM + discovery env var) instead of silently dropping it.
  const managedArn = memory.managedMemoryConfiguration?.arn;
  if (managedArn) {
    return { mode: 'existing', arn: managedArn } as NonNullable<HarnessSpec['memory']>;
  }

  // No ARN to reference yet (managed-but-unprovisioned, or an SDK-unknown variant that resolves to
  // managed). Return the `managed` marker for completeness, but note resolveMemoryProviders only
  // wires `existing` refs — so this path produces NO memory on the exported agent today. It is a
  // rare fallback: a READY harness always has the arn and takes the existing-by-arn path above. If
  // managed-without-arn ever needs real handling, wire it (provision a project memory or emit a note)
  // in resolveMemoryProviders rather than here.
  const asRecord = memory as unknown as Record<string, unknown>;
  if ('managedMemoryConfiguration' in asRecord || hasUnknownManagedMember(asRecord)) {
    return { mode: 'managed' } as NonNullable<HarnessSpec['memory']>;
  }
  return undefined;
}

/** True when the SDK surfaced an unmodeled memory member that names the managed configuration. */
function hasUnknownManagedMember(memory: Record<string, unknown>): boolean {
  const unknown = memory.SDK_UNKNOWN_MEMBER as { name?: string } | undefined;
  return unknown?.name === 'managedMemoryConfiguration';
}

/**
 * Map the control-plane runtime-environment block onto the local HarnessSpec fields:
 *   - networkConfiguration -> networkMode + networkConfig (VPC subnets/securityGroups)
 *   - lifecycleConfiguration -> lifecycleConfig (idle/maxLifetime; same field names)
 *   - filesystemConfigurations[] (tagged union) -> sessionStoragePath / efsAccessPoints / s3AccessPoints
 * Returns a partial spec spread into the HarnessSpec; emits only the fields that are present.
 */
function mapRuntimeEnvironment(env: HarnessAgentCoreRuntimeEnvironment | undefined): Partial<HarnessSpec> {
  if (!env) return {};
  const out: Record<string, unknown> = {};

  // Network: PUBLIC is the implicit default locally, so only carry VPC (with its config). The local
  // AgentEnvSpec schema requires BOTH subnets and securityGroups when networkMode is VPC; a VPC
  // harness missing either (e.g. AWS-default subnets) can't be expressed. Fail here — during the
  // pre-write fetch — with a clear message rather than emitting networkMode:'VPC' with no
  // networkConfig and crashing later in writeProjectSpec's schema validation, after the agent dir
  // and code have already been written.
  const net = env.networkConfiguration;
  if (net?.networkMode === 'VPC') {
    const subnets = net.networkModeConfig?.subnets;
    const securityGroups = net.networkModeConfig?.securityGroups;
    if (!subnets?.length || !securityGroups?.length) {
      throw new ValidationError(
        'This harness runs in a VPC but its network configuration is missing explicit subnets and/or ' +
          'security groups, which the exported agent requires. Re-create the harness with explicit VPC ' +
          'subnets and security groups, or export a non-VPC harness.'
      );
    }
    out.networkMode = 'VPC';
    out.networkConfig = { subnets, securityGroups };
  }

  // Lifecycle: same field names; drop unset members.
  const lc = env.lifecycleConfiguration;
  if (lc && (lc.idleRuntimeSessionTimeout != null || lc.maxLifetime != null)) {
    out.lifecycleConfig = clean({
      idleRuntimeSessionTimeout: lc.idleRuntimeSessionTimeout,
      maxLifetime: lc.maxLifetime,
    });
  }

  // Filesystem mounts: a tagged-union list -> the flat local fields.
  const efs: { accessPointArn: string; mountPath: string }[] = [];
  const s3: { accessPointArn: string; mountPath: string }[] = [];
  for (const fs of env.filesystemConfigurations ?? []) {
    if (fs.sessionStorage?.mountPath) {
      out.sessionStoragePath = fs.sessionStorage.mountPath;
    } else if (fs.efsAccessPoint?.accessPointArn && fs.efsAccessPoint.mountPath) {
      efs.push({ accessPointArn: fs.efsAccessPoint.accessPointArn, mountPath: fs.efsAccessPoint.mountPath });
    } else if (fs.s3FilesAccessPoint?.accessPointArn && fs.s3FilesAccessPoint.mountPath) {
      s3.push({ accessPointArn: fs.s3FilesAccessPoint.accessPointArn, mountPath: fs.s3FilesAccessPoint.mountPath });
    }
  }
  if (efs.length) out.efsAccessPoints = efs;
  if (s3.length) out.s3AccessPoints = s3;

  return out as Partial<HarnessSpec>;
}

/** Drop undefined-valued keys so optional fields don't serialize as `undefined`. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
