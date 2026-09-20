import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../../../io";
import { ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import {
  AwsDeploymentTargetSchema,
  type AwsDeploymentTarget,
} from "../../../../projectSchemas/aws-targets";
import { DeployedStateSchema, stackReferenceOf } from "../cdk/deployedState";

export const TerraformOutputSchema = z.object({
  agentcore: z.object({
    value: z.object({
      version: z.literal(1),
      project: z.string(),
      target: AwsDeploymentTargetSchema,
      resources: z.array(
        z.object({
          resourceType: z.enum(["runtime", "memory"]),
          name: z.string(),
          id: z.string().min(1),
          arn: z.string().min(1),
        }),
      ),
    }),
  }),
});

const OwnerSchema = z.object({
  version: z.literal(1),
  project: z.string(),
  provider: z.string(),
  target: AwsDeploymentTargetSchema,
  applied: z.boolean().optional(),
});

export function terraformDirectory(project: Project, target: AwsDeploymentTarget): string {
  return join(project.rootPath, "agentcore", "terraform", target.name);
}

export function sameTarget(a: AwsDeploymentTarget, b: AwsDeploymentTarget): boolean {
  return a.name === b.name && a.account === b.account && a.region === b.region;
}

/** Refuses changing resource engines just by editing managedBy. No implicit adoption. */
export async function assertBackendOwnership(
  project: Project,
  target: AwsDeploymentTarget,
): Promise<void> {
  const cdkStatePath = join(project.rootPath, "agentcore", ".cli", "deployed-state.json");
  if (project.spec.managedBy === "TERRAFORM" && existsSync(cdkStatePath)) {
    const state = DeployedStateSchema.parse(JSON.parse(await readFile(cdkStatePath, "utf8")));
    if (
      stackReferenceOf(state.targets[target.name]) ||
      Object.keys(state.targets[target.name]?.resources?.credentials ?? {}).length
    ) {
      throw new ProjectStateError(
        "This target is already managed by CDK. Migrate ownership explicitly before selecting Terraform.",
      );
    }
  }
  if (
    project.spec.managedBy === "CDK" &&
    existsSync(join(terraformDirectory(project, target), "deployment.json"))
  ) {
    throw new ProjectStateError(
      "This target is already bound to Terraform. Migrate ownership explicitly before selecting CDK.",
    );
  }
}

/**
 * The small committed binding contains no Terraform state or credentials. It also
 * prevents another checkout from changing a target account under an existing state.
 */
export class TerraformState {
  constructor(readonly provider: string) {}

  async check(project: Project, target: AwsDeploymentTarget): Promise<boolean> {
    await assertBackendOwnership(project, target);
    const directory = terraformDirectory(project, target);
    const path = join(directory, "deployment.json");
    if (!existsSync(path)) {
      if (
        existsSync(join(directory, "terraform.tfstate")) ||
        existsSync(join(directory, ".terraform"))
      ) {
        throw new ProjectStateError(
          `Terraform state in ${directory} has no deployment binding. Restore deployment.json before continuing.`,
        );
      }
      return false;
    }
    const owner = OwnerSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (
      owner.project !== project.name ||
      owner.provider !== this.provider ||
      !sameTarget(owner.target, target)
    ) {
      throw new ProjectStateError(
        "Terraform deployment binding differs from the project, provider, or target. An explicit state migration is required.",
      );
    }
    return true;
  }

  async bind(project: Project, target: AwsDeploymentTarget): Promise<void> {
    if (await this.check(project, target)) return;
    await atomicWrite(
      join(terraformDirectory(project, target), "deployment.json"),
      `${JSON.stringify({ version: 1, project: project.name, provider: this.provider, target }, null, 2)}\n`,
    );
  }

  async wasApplied(project: Project, target: AwsDeploymentTarget): Promise<boolean> {
    const path = join(terraformDirectory(project, target), "deployment.json");
    return OwnerSchema.parse(JSON.parse(await readFile(path, "utf8"))).applied === true;
  }

  async recordApply(project: Project, target: AwsDeploymentTarget): Promise<void> {
    await atomicWrite(
      join(terraformDirectory(project, target), "deployment.json"),
      `${JSON.stringify({ version: 1, project: project.name, provider: this.provider, target, applied: true }, null, 2)}\n`,
    );
  }

  parseOutputs(raw: unknown, project: Project, target: AwsDeploymentTarget) {
    const output = TerraformOutputSchema.parse(raw).agentcore.value;
    if (output.project !== project.name || !sameTarget(output.target, target)) {
      throw new ProjectStateError("Terraform outputs do not belong to this project and target.");
    }
    const keys = new Set<string>();
    for (const resource of output.resources) {
      const key = `${resource.resourceType}/${resource.name}`;
      const parts = resource.arn.split(":");
      if (
        keys.has(key) ||
        parts[2] !== "bedrock-agentcore" ||
        parts[3] !== target.region ||
        parts[4] !== target.account ||
        parts.slice(5).join(":") !== `${resource.resourceType}/${resource.id}`
      ) {
        throw new ProjectStateError(`Invalid or duplicate Terraform resource output '${key}'.`);
      }
      keys.add(key);
    }
    return output.resources;
  }
}

/** Serializes generation and apply as well as Terraform's own state locking. */
export async function lockTarget(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, ".agentcore.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new ProjectStateError(
      `Another deployment owns ${path}. If it exited, confirm no process is using the target before removing that lock.`,
    );
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await unlink(path);
  };
}
