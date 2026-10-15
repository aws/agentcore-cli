import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";

const resourceSchema = z.object({
  resourceType: z.enum([
    "runtime",
    "memory",
    "gateway",
    "gateway-target",
    "policy-engine",
    "policy",
    "online-eval",
  ]),
  name: z.string(),
  parentName: z.string().optional(),
  arn: z.string().optional(),
  id: z.string(),
});

export type TerraformResource = z.infer<typeof resourceSchema>;

const stateSchema = z.object({
  resources: z
    .array(z.object({ mode: z.string() }).passthrough())
    .optional()
    .default([]),
  outputs: z
    .record(z.string(), z.object({ value: z.unknown() }).passthrough())
    .optional()
    .default({}),
});

/** A local Terraform state belongs to exactly one project, target, account, and region. */
export class TerraformState {
  readonly directory: string;

  constructor(project: Project, target: AwsDeploymentTarget | "build") {
    const key = target === "build" ? "build" : `${target.name}-${target.account}-${target.region}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new ProjectStateError("Invalid Terraform target directory");
    }
    this.directory = join(project.rootPath, "agentcore", "terraform", key);
  }

  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, ".agentcore-operation.lock");
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ProjectStateError(
        `Another operation owns ${path}. If its process has stopped, remove the lock file and retry.`,
      );
    }
    return () => rm(path, { force: true });
  }

  private async read() {
    let text: string;
    try {
      text = await readFile(join(this.directory, "terraform.tfstate"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new ProjectStateError(
        `Cannot read Terraform state in ${this.directory}. Preserve the state file and repair it before retrying.`,
      );
    }
    return parsed.data;
  }

  async hasManagedResources(): Promise<boolean> {
    return (await this.read())?.resources.some(({ mode }) => mode === "managed") ?? false;
  }

  async outputs(): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      Object.entries((await this.read())?.outputs ?? {}).map(([key, output]) => [
        key,
        output.value,
      ]),
    );
  }

  async resources(): Promise<TerraformResource[]> {
    const outputs = await this.outputs();
    if (outputs.project_resources === undefined) return [];
    const parsed = z.array(resourceSchema).safeParse(outputs.project_resources);
    if (!parsed.success) {
      throw new ProjectStateError(
        `Terraform project_resources output in ${this.directory} is not a recognized resource list.`,
      );
    }
    return parsed.data;
  }
}
