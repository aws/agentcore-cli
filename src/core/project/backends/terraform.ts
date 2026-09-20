import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { z } from "zod";
import {
  atomicWrite,
  requireTool,
  runProcess,
  createLineSplitter,
  type ProcessRunner,
} from "../../../io";
import { withOutputEvents } from "../events";
import { ProjectStateError } from "../../../errors";
import type { AwsCredentialProvider } from "../../types";
import type {
  Project,
  ProjectEvent,
  DeployResult,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type {
  ProjectBackend,
  DeployBackendInput,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "./types";
import { TerraformCompiler } from "./terraform/compiler";
import { PythonArtifactBuilder } from "./terraform/packager";
import { TerraformRunner } from "./terraform/runner";
import { lockTarget, TerraformState, terraformDirectory } from "./terraform/state";

const PlanSchema = z.object({
  resource_changes: z
    .array(
      z.object({
        address: z.string(),
        change: z.object({ actions: z.array(z.string()) }),
      }),
    )
    .default([]),
});

export type TerraformIdentity = {
  account: string;
  credentials: AwsCredentialProvider;
};
export type TerraformBackendConfig = {
  runner?: ProcessRunner;
  terraform?: TerraformRunner;
  compiler?: TerraformCompiler;
  checkTool?: typeof requireTool;
  resolveIdentity?: (region: string) => Promise<TerraformIdentity>;
};

async function resolveIdentity(region: string): Promise<TerraformIdentity> {
  const client = new STSClient({ region });
  try {
    const { Account } = await client.send(new GetCallerIdentityCommand({}));
    if (!Account) throw new ProjectStateError("STS returned no account ID.");
    return { account: Account, credentials: client.config.credentials };
  } finally {
    client.destroy();
  }
}

/**
 * Runs the Terraform root for the selected target. Terraform manages each resource
 * and its state; the CLI supplies project configuration and normalizes the outputs.
 */
export class TerraformBackend implements ProjectBackend {
  private readonly compiler: TerraformCompiler;
  private readonly artifacts: PythonArtifactBuilder;
  private readonly terraform: TerraformRunner;
  private readonly state: TerraformState;
  private readonly checkTool: typeof requireTool;
  private readonly resolveIdentity: (region: string) => Promise<TerraformIdentity>;

  constructor(config: TerraformBackendConfig = {}) {
    this.compiler = config.compiler ?? new TerraformCompiler();
    this.artifacts = new PythonArtifactBuilder(config.runner ?? runProcess);
    this.terraform = config.terraform ?? new TerraformRunner();
    this.state = new TerraformState(this.compiler.provider.identity);
    this.checkTool = config.checkTool ?? requireTool;
    this.resolveIdentity = config.resolveIdentity ?? resolveIdentity;
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    this.compiler.validate(project);
    yield { type: "step", message: "Building Terraform runtime artifacts" };
    yield* this.buildArtifacts(project);
  }

  private async *buildArtifacts(project: Project) {
    return yield* withOutputEvents(async (emit) => {
      const lines = createLineSplitter(emit);
      try {
        return await this.artifacts.build(project, lines.push);
      } finally {
        lines.flush();
      }
    });
  }

  private async identity(target: AwsDeploymentTarget): Promise<TerraformIdentity> {
    const identity = await this.resolveIdentity(target.region);
    if (identity.account !== target.account) {
      throw new ProjectStateError(
        `Active AWS account ${identity.account} differs from target ${target.account}.`,
      );
    }
    return identity;
  }

  private async environment(
    identity: TerraformIdentity,
    target: AwsDeploymentTarget,
    directory: string,
  ): Promise<NodeJS.ProcessEnv> {
    const credentials = await identity.credentials();
    // Pin both providers and the state backend to the credentials checked by STS.
    // Do not persist credentials in the generated configuration, plan arguments, or binding.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TF_CLI_ARGS") &&
          !["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "TF_WORKSPACE", "TF_DATA_DIR"].includes(key),
      ),
    );
    return {
      ...env,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
      AWS_REGION: target.region,
      AWS_DEFAULT_REGION: target.region,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_WORKSPACE: "default",
      TF_DATA_DIR: join(directory, ".terraform"),
    };
  }

  public async *deploy(
    project: Project,
    { target, confirmTeardown }: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    this.compiler.validate(project);
    await this.state.check(project, target);
    await this.checkTool(
      "terraform",
      "Install Terraform >= 1.10: https://developer.hashicorp.com/terraform/install",
    );
    const identity = await this.identity(target);
    const directory = terraformDirectory(project, target);
    const release = await lockTarget(directory);
    try {
      yield { type: "step", message: "Building Terraform runtime artifacts" };
      const artifacts = yield* this.buildArtifacts(project);
      // Compile the whole project before writing a new target binding or Terraform root.
      const configuration = this.compiler.compile(project, target, artifacts);
      await this.state.bind(project, target);
      await atomicWrite(
        join(directory, "agentcore.generated.tf.json"),
        `${JSON.stringify(configuration, null, 2)}\n`,
        { mode: 0o600 },
      );
      const env = () => this.environment(identity, target, directory);
      yield { type: "step", message: "Initializing Terraform" };
      yield* this.terraform.run(["init", "-input=false", "-no-color"], directory, await env());
      yield* this.terraform.run(["validate", "-no-color"], directory, await env());
      if (await this.state.wasApplied(project, target)) {
        // A committed binding with an empty new local state must never redeploy
        // the same target. Remote backends have been initialized at this point.
        const previous = await this.terraform.json(["output", "-json"], directory, await env());
        this.state.parseOutputs(previous, project, target);
      }
      const plan = `agentcore-${randomUUID()}.tfplan`;
      yield { type: "step", message: `Planning Terraform deployment in ${directory}` };
      yield* this.terraform.run(
        ["plan", "-input=false", "-no-color", "-lock-timeout=60s", `-out=${plan}`],
        directory,
        await env(),
      );
      const details = PlanSchema.parse(
        await this.terraform.json(["show", "-json", plan], directory, await env()),
      );
      const removals = details.resource_changes.filter(({ change }) =>
        change.actions.includes("delete"),
      );
      if (
        removals.length > 0 &&
        !(await confirmTeardown({
          projectName: project.name,
          targetName: target.name,
          account: target.account,
          region: target.region,
          resourceDescription: removals.map(({ address }) => address).join(", "),
        }))
      ) {
        throw new ProjectStateError(
          `Terraform apply cancelled; the reviewed plan remains at ${join(directory, plan)}.`,
        );
      }
      yield { type: "step", message: "Applying the saved Terraform plan" };
      yield* this.terraform.run(
        ["apply", "-input=false", "-no-color", "-lock-timeout=60s", plan],
        directory,
        await env(),
      );
      const resources = this.state.parseOutputs(
        await this.terraform.json(["output", "-json"], directory, await env()),
        project,
        target,
      );
      await this.state.recordApply(project, target);
      return {
        outputs: Object.fromEntries(
          resources.map((resource) => [`${resource.resourceType}/${resource.name}`, resource.arn]),
        ),
        ...(resources.length === 0 && removals.length > 0 && { tornDown: true }),
      };
    } finally {
      await release();
    }
  }

  private async resources(project: Project, target: AwsDeploymentTarget) {
    if (!(await this.state.check(project, target))) return [];
    const identity = await this.identity(target);
    const directory = terraformDirectory(project, target);
    const raw = await this.terraform.json(
      ["output", "-json"],
      directory,
      await this.environment(identity, target, directory),
    );
    if (typeof raw === "object" && raw !== null && Object.keys(raw).length === 0) return [];
    return this.state.parseOutputs(raw, project, target);
  }

  public async resolveDeployedResources(
    project: Project,
    { target }: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const resources = await this.resources(project, target);
    if (!resources.length) return [];
    const { credentials } = await this.identity(target);
    return resources
      .filter((resource) => resource.resourceType === "runtime")
      .map((resource) => ({
        resourceType: "runtime",
        name: resource.name,
        id: resource.id,
        target,
        credentialProvider: credentials,
      }));
  }

  public async resolveProjectResources(
    project: Project,
    { target }: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    this.compiler.validate(project);
    const deployed = await this.resources(project, target);
    const declarations = [
      ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...project.spec.memories.map(({ name }) => ({ resourceType: "memory" as const, name })),
    ];
    return declarations.map((resource) => {
      const found = deployed.find(
        (item) => item.resourceType === resource.resourceType && item.name === resource.name,
      );
      return found
        ? { ...resource, deploymentState: "deployed", id: found.id }
        : { ...resource, deploymentState: "local-only" };
    });
  }
}
