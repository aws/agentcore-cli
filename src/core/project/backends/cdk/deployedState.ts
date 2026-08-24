import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Project } from "../../../../handlers/project/types";
import type { ReadWriteJson } from "../../../../io";
import type { DeployedCredentials } from "./credentials";

/** Project-relative path of the state file the synthesized CDK app reads. */
export const DEPLOYED_STATE_RELATIVE_PATH = join("agentcore", ".cli", "deployed-state.json");

const CredentialStateSchema = z.object({
  credentialProviderArn: z.string(),
  clientSecretArn: z.string().optional(),
});

// Only the branch this CLI writes is modelled. Every other key the CDK app
// records under a target — runtimes, memories, stackName, and the rest of
// DeployedStateSchema in @aws/agentcore-cdk — passes through untouched so a
// merge never drops state this code does not own.
const ResourceStateSchema = z
  .object({
    credentials: z.record(z.string(), CredentialStateSchema).optional(),
  })
  .passthrough();

const TargetStateSchema = z
  .object({
    resources: ResourceStateSchema.optional(),
  })
  .passthrough();

export const DeployedStateSchema = z
  .object({
    targets: z.record(z.string(), TargetStateSchema).default({}),
  })
  .passthrough();

/**
 * Records the credential providers a deploy provisioned, merging into any state
 * already on disk. The written map replaces the target's previous one so a
 * credential dropped from agentcore.json stops being advertised to the CDK app,
 * while other targets and other resource kinds are preserved.
 */
export async function writeDeployedCredentials(
  json: ReadWriteJson,
  project: Project,
  targetName: string,
  credentials: DeployedCredentials,
): Promise<void> {
  const statePath = join(project.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
  const exists = existsSync(statePath);
  // Nothing to record and no file to correct: leave the project untouched rather
  // than creating an empty state file.
  if (!exists && Object.keys(credentials).length === 0) return;

  const state = exists ? await json.read(statePath, DeployedStateSchema) : { targets: {} };
  const target = state.targets[targetName] ?? {};
  const { credentials: _previous, ...resources } = target.resources ?? {};

  await json.write(statePath, {
    ...state,
    targets: {
      ...state.targets,
      [targetName]: {
        ...target,
        resources: {
          ...resources,
          ...(Object.keys(credentials).length > 0 && { credentials }),
        },
      },
    },
  });
}
