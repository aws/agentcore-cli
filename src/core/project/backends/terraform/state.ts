import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
  readonly targetDirectory: string;
  readonly dataDirectory: string;
  readonly statePath: string;
  readonly variablesPath: string;
  readonly planPath: string;

  constructor(project: Project, target: AwsDeploymentTarget | string = DEFAULT_TARGET_NAME) {
    const key = typeof target === "string" ? target : target.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new ProjectStateError("Invalid Terraform target directory");
    }
    this.directory = join(project.rootPath, "agentcore", "terraform");
    this.targetDirectory = join(this.directory, ".targets", key);
    this.dataDirectory = join(this.targetDirectory, ".terraform");
    this.statePath = join(this.targetDirectory, "terraform.tfstate");
    this.variablesPath = join(this.targetDirectory, "deployment.tfvars.json");
    this.planPath = join(this.targetDirectory, "deployment.tfplan");
  }

  /** Preserve earlier target roots and state instead of silently creating another deployment. */
  async assertNoLegacyState(): Promise<void> {
    if (!existsSync(this.directory)) return;
    const children = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ![".targets", ".terraform"].includes(entry.name))
      .map((entry) => join(this.directory, entry.name));
    for (const path of [this.directory, ...children]) {
      const files = path === this.directory ? [] : await readdir(path);
      const legacyRoot =
        files.some((name) => name.endsWith(".tf") || name.endsWith(".tf.json")) &&
        (files.some((name) =>
          ["artifacts.json", "deployment.auto.tfvars.json", ".agentcore-target.json"].includes(
            name,
          ),
        ) ||
          (await this.readOptional(join(path, "main.tf")))?.includes("/../../agentcore.json"));
      if (legacyRoot) {
        throw new ProjectStateError(
          `An earlier Terraform target root exists at ${path}. ` +
            "Automatic migration is not supported; preserve its configuration and state before moving to the shared root.",
        );
      }
      for (const filename of ["terraform.tfstate", "terraform.tfstate.backup"]) {
        const text = await this.readOptional(join(path, filename));
        if (
          text !== undefined &&
          stateSchema.parse(JSON.parse(text)).resources.some(({ mode }) => mode === "managed")
        ) {
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
    const binding = await this.readOptional(join(this.targetDirectory, ".agentcore-target.json"));
    const state = await this.read();
    if (state === undefined) {
      const backup = await this.readOptional(`${this.statePath}.backup`);
      if (
        backup &&
        stateSchema.parse(JSON.parse(backup)).resources.some(({ mode }) => mode === "managed")
      ) {
        throw new ProjectStateError(
          `The current Terraform state is missing from ${this.targetDirectory}, but its backup contains resources. ` +
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
          `Terraform state in ${this.targetDirectory} is bound to a different target, account, or region. ` +
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
        `Terraform resources in ${this.targetDirectory} have no deployment target identity. ` +
          "Preserve the state and use Terraform directly to repair the deployment_target output before using the CLI.",
      );
    }
  }

  async bind(target: AwsDeploymentTarget): Promise<void> {
    await this.assertTarget(target);
    await mkdir(this.targetDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(
      join(this.targetDirectory, ".agentcore-target.json"),
      `${JSON.stringify({ name: target.name, account: target.account, region: target.region }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async assertLocalBackend(): Promise<void> {
    // Plain Terraform uses root/.terraform unless the caller sets TF_DATA_DIR.
    // Check that metadata too before initializing an independent target directory.
    for (const dataDirectory of [this.dataDirectory, join(this.directory, ".terraform")]) {
      const text = await this.readOptional(join(dataDirectory, "terraform.tfstate"));
      if (text === undefined) continue;
      const metadata = JSON.parse(text) as {
        backend?: { type?: string; config?: { path?: string; workspace_dir?: string } };
      };
      const backend = metadata.backend;
      if (!backend) continue;
      const statePath = resolve(this.directory, backend.config?.path || "terraform.tfstate");
      const canonicalRootPath = /^\.targets\/[a-zA-Z0-9_-]+\/terraform\.tfstate$/.test(
        relative(this.directory, statePath).replaceAll("\\", "/"),
      );
      if (
        backend.type !== "local" ||
        (dataDirectory === this.dataDirectory
          ? statePath !== this.statePath
          : !canonicalRootPath) ||
        (backend.config?.workspace_dir &&
          resolve(this.directory, backend.config.workspace_dir) !==
            join(this.directory, "terraform.tfstate.d"))
      ) {
        throw new ProjectStateError(
          `CLI Terraform operations require local state under .targets/<target>/terraform.tfstate. ` +
            `The initialized backend in ${dataDirectory} uses a different location or backend. ` +
            "Use Terraform directly with a remote backend or a custom state path.",
        );
      }
    }
  }

  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, ".agentcore-operation.lock");
    const claim = async () => {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
    };
    try {
      await claim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A killed CLI never runs its own release, so without a takeover a single crash
      // leaves the project unable to build or deploy until the customer finds this file.
      // The local backend keeps state on one host, so an owner pid that no longer exists
      // can only be a dead operation. Terraform's own state lock still guards the state.
      if (await this.lockOwnerRunning(path))
        throw new ProjectStateError(
          `Another operation owns ${path}. Wait for it to finish, then retry.`,
        );
      await rm(path, { force: true });
      await claim().catch(() => {
        throw new ProjectStateError(
          `Another operation claimed ${path} while this one recovered a stale lock. Retry.`,
        );
      });
    }
    return () => rm(path, { force: true });
  }

  /** Whether the process that wrote the lock file is still alive on this host. */
  private async lockOwnerRunning(path: string): Promise<boolean> {
    const owner = await readFile(path, "utf8")
      .then((text) => z.object({ pid: z.number().int().positive() }).safeParse(JSON.parse(text)))
      .catch(() => undefined);
    // An unreadable or pid-less lock predates this check; leave it to the operator.
    if (!owner?.success) return true;
    try {
      process.kill(owner.data.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async read() {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = stateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new ProjectStateError(
        `Cannot read Terraform state in ${this.targetDirectory}. Preserve the state file and repair it before retrying.`,
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
        `Terraform project_resources output in ${this.targetDirectory} is not a recognized resource list.`,
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
