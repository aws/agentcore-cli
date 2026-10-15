import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import {
  AwsDeploymentTargetSchema,
  DEFAULT_TARGET_NAME,
  type AwsDeploymentTarget,
} from "../../../../projectSchemas/aws-targets";
import { atomicWrite } from "../../../../io";

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

  constructor(project: Project, target: AwsDeploymentTarget | string = DEFAULT_TARGET_NAME) {
    const key = typeof target === "string" ? target : target.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new ProjectStateError("Invalid Terraform target directory");
    }
    this.directory = join(project.rootPath, "agentcore", "terraform", key);
  }

  /** Never silently start a second state beside the earlier PoC directory layout. */
  async assertNoLegacyState(): Promise<void> {
    const root = dirname(this.directory);
    if (!existsSync(root)) return;
    const legacy = [
      root,
      ...(await readdir(root, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() && (entry.name === "build" || /-\d{12}-[a-z]+-/.test(entry.name)),
        )
        .map((entry) => join(root, entry.name)),
    ];
    directories: for (const path of legacy) {
      if (path === this.directory) continue;
      const binding = await this.readOptional(join(path, ".agentcore-target.json"));
      const parsedBinding =
        binding === undefined
          ? undefined
          : AwsDeploymentTargetSchema.safeParse(JSON.parse(binding));
      if (
        path !== root &&
        parsedBinding?.success &&
        parsedBinding.data.name === basename(path) &&
        existsSync(join(path, "main.tf"))
      ) {
        continue;
      }
      for (const name of ["terraform.tfstate", "terraform.tfstate.backup"]) {
        const text = await this.readOptional(join(path, name));
        if (text === undefined) continue;
        const parsed = stateSchema.parse(JSON.parse(text));
        const identity = AwsDeploymentTargetSchema.safeParse(
          parsed.outputs.deployment_target?.value,
        );
        if (path !== root && identity.success && identity.data.name === basename(path))
          continue directories;
        if (parsed.resources.some(({ mode }) => mode === "managed")) {
          throw new ProjectStateError(
            `Existing Terraform resources use the earlier state directory ${path}. ` +
              "Automatic state migration is not supported; preserve that state and manage it from its existing directory.",
          );
        }
      }
    }
  }

  /** Verify local state before using or replacing the target's deployment inputs. */
  async assertTarget(target: AwsDeploymentTarget): Promise<void> {
    await this.assertNoLegacyState();
    await this.assertLocalBackend();
    const binding = await this.readOptional(join(this.directory, ".agentcore-target.json"));
    const state = await this.read();
    if (state === undefined) {
      const backup = await this.readOptional(join(this.directory, "terraform.tfstate.backup"));
      if (
        backup &&
        stateSchema.parse(JSON.parse(backup)).resources.some(({ mode }) => mode === "managed")
      ) {
        throw new ProjectStateError(
          `The current Terraform state is missing from ${this.directory}, but its backup contains resources. ` +
            "Restore or repair the current state before deploying; the CLI will not start another deployment.",
        );
      }
    }
    const stateTarget = state?.outputs.deployment_target?.value;
    for (const value of [binding === undefined ? undefined : JSON.parse(binding), stateTarget]) {
      if (value === undefined) continue;
      const parsed = AwsDeploymentTargetSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.name !== target.name ||
        parsed.data.account !== target.account ||
        parsed.data.region !== target.region
      ) {
        throw new ProjectStateError(
          `Terraform state in ${this.directory} is bound to a different target, account, or region. ` +
            "Use its original deployment target or a new named target; existing state will not be reassigned.",
        );
      }
    }
    if (
      binding === undefined &&
      stateTarget === undefined &&
      state?.resources.some(({ mode }) => mode === "managed")
    ) {
      throw new ProjectStateError(
        `Terraform resources in ${this.directory} have no deployment target identity. ` +
          "Preserve the state and use Terraform directly to repair the deployment_target output before using the CLI.",
      );
    }
  }

  async bind(target: AwsDeploymentTarget): Promise<void> {
    await this.assertTarget(target);
    await atomicWrite(
      join(this.directory, ".agentcore-target.json"),
      `${JSON.stringify({ name: target.name, account: target.account, region: target.region }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async assertLocalBackend(): Promise<void> {
    const text = await this.readOptional(join(this.directory, ".terraform", "terraform.tfstate"));
    if (text === undefined) return;
    const metadata = JSON.parse(text) as {
      backend?: { type?: string; config?: { path?: string; workspace_dir?: string } };
    };
    const backend = metadata.backend;
    if (
      (backend?.type && backend.type !== "local") ||
      (backend?.config?.path &&
        resolve(this.directory, backend.config.path) !==
          join(this.directory, "terraform.tfstate")) ||
      (backend?.config?.workspace_dir &&
        resolve(this.directory, backend.config.workspace_dir) !==
          join(this.directory, "terraform.tfstate.d"))
    ) {
      throw new ProjectStateError(
        "CLI Terraform operations require local state at this target's terraform.tfstate. " +
          "Use Terraform directly with a remote backend or a custom state path.",
      );
    }
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

  async hasApplicationResources(): Promise<boolean> {
    return (
      (await this.read())?.resources.some(
        ({ mode, module }) =>
          mode === "managed" &&
          typeof module === "string" &&
          (module === "module.application" || module.startsWith("module.application.")),
      ) ?? false
    );
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

  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
