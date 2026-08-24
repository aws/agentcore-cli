import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors/errors";
import type { ReadWriteJson } from "../../../../io";

const TARGET_TAG = "agentcore:target-name";
const STACK_ARTIFACT = "aws:cloudformation:stack";
/** What CDK writes in an artifact's `environment` when the stack is env-agnostic. */
const UNKNOWN_ACCOUNT = "unknown-account";
const UNKNOWN_REGION = "unknown-region";

const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        environment: z.string().optional(),
        properties: z
          .object({
            tags: z.record(z.string(), z.string()).optional(),
            templateFile: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default({}),
});

const StackTemplateSchema = z
  .object({
    Resources: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/** The synthesized stack a deploy selected, and where its template lives. */
export interface StackArtifact {
  /** Artifact id the CDK Toolkit selects the stack by. */
  id: string;
  /** Assembly-relative path of the synthesized template. */
  templateFile: string | undefined;
}

/** The account and region a deploy expects its stack to be bound to. */
export interface StackEnvironment {
  account: string;
  region: string;
}

/**
 * Finds the one synthesized stack artifact tagged for the selected deployment
 * target, and checks it is bound to the environment that target names.
 */
export async function stackArtifactForTarget(
  json: ReadWriteJson,
  assemblyDirectory: string,
  target: string,
  expected: StackEnvironment,
): Promise<StackArtifact> {
  const manifestPath = join(assemblyDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ProjectStateError(`No synthesized cloud assembly was found at ${manifestPath}.`);
  }

  const manifest = await json.read(manifestPath, AssemblyManifestSchema);
  const stacks = Object.entries(manifest.artifacts).filter(
    ([, artifact]) => artifact.type === STACK_ARTIFACT,
  );
  const matches = stacks.filter(
    ([, artifact]) => artifact.properties?.tags?.[TARGET_TAG] === target,
  );

  if (matches.length === 0) {
    throw new ProjectStateError(
      `The synthesized cloud assembly has no stack for deployment target '${target}'. ` +
        `${manifestPath} defines ${stacks.length} stack(s), none tagged ${TARGET_TAG}='${target}'.`,
    );
  }
  if (matches.length > 1) {
    throw new ProjectStateError(
      `The synthesized cloud assembly has ${matches.length} stacks for deployment target ` +
        `'${target}'. Exactly one stack must be tagged ${TARGET_TAG}='${target}'.`,
    );
  }

  const [id, artifact] = matches[0]!;
  assertEnvironmentMatches(id, artifact.environment, expected);
  return { id, templateFile: artifact.properties?.templateFile };
}

/**
 * Refuses to deploy a synthesized template that declares no resources.
 *
 * The CDK Toolkit reads such a template as an instruction to *delete* an
 * existing stack of that name, and reports the run as a normal success. Without
 * this check `project deploy` is the only way to destroy a deployed stack, and
 * there is no `project destroy` for a user to have asked for it with.
 */
export async function assertStackHasResources(
  json: ReadWriteJson,
  assemblyDirectory: string,
  artifact: StackArtifact,
): Promise<void> {
  // The cloud assembly schema requires templateFile on a stack artifact, so its
  // absence is a malformed assembly rather than a stack to deploy unchecked.
  if (artifact.templateFile === undefined) {
    throw new ProjectStateError(
      `Stack artifact '${artifact.id}' names no template file in the cloud assembly manifest.`,
    );
  }

  const templatePath = join(assemblyDirectory, artifact.templateFile);
  if (!existsSync(templatePath)) {
    throw new ProjectStateError(
      `The synthesized template for stack '${artifact.id}' is missing from the cloud ` +
        `assembly at ${templatePath}.`,
    );
  }

  const template = await json.read(templatePath, StackTemplateSchema);
  if (Object.keys(template.Resources).length === 0) {
    throw new ProjectStateError(
      `The synthesized stack '${artifact.id}' declares no resources, so deploying it would ` +
        `delete the existing stack rather than update it. Check that the project spec still ` +
        `declares the runtimes, gateways and memories it should before deploying.`,
    );
  }
}

// Both the target tag and the stack's environment derive from the same target in
// the synthesized app, so today they cannot disagree. Checking anyway keeps a
// correct tag from carrying a stack into the wrong account or region: the Toolkit
// deploys where the artifact's environment points, not where the tag says.
function assertEnvironmentMatches(
  id: string,
  environment: string | undefined,
  expected: StackEnvironment,
): void {
  // An artifact with no environment is environment-agnostic: it deploys into
  // whatever the credentials resolve to, which the account preflight checked.
  if (environment === undefined) return;

  const parsed = /^aws:\/\/([^/]+)\/(.+)$/.exec(environment);
  if (!parsed) {
    throw new ProjectStateError(
      `Stack artifact '${id}' declares an unrecognized environment '${environment}'. ` +
        `Expected the form aws://<account>/<region>.`,
    );
  }

  const account = parsed[1]!;
  const region = parsed[2]!;
  // The unknown-* placeholders are the env-agnostic case spelled out.
  const mismatches = [
    account !== UNKNOWN_ACCOUNT && account !== expected.account
      ? `account ${account} (target expects ${expected.account})`
      : undefined,
    region !== UNKNOWN_REGION && region !== expected.region
      ? `region ${region} (target expects ${expected.region})`
      : undefined,
  ].filter((mismatch) => mismatch !== undefined);

  if (mismatches.length > 0) {
    throw new ProjectStateError(
      `The synthesized stack '${id}' is built for ${mismatches.join(" and ")}. ` +
        `Re-synthesize the project so its stack matches the deployment target.`,
    );
  }
}
