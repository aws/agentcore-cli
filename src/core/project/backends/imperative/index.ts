import { randomUUID } from "node:crypto";
import type {
  CreateHarnessRequest,
  Harness,
  HarnessSkill as ServiceHarnessSkill,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { CoreHarnessClient } from "../../../../handlers/harness/types";
import type {
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../../../io";
import type { Logger } from "../../../../logging";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { HarnessRegistryEntry } from "../../../../projectSchemas/harness";
import { executePlan, type ExecutePlanOptions, type Plan, type Step } from "../../../plan";
import type { CoreOptions } from "../../../types";
import { desiredExecutionPolicy, type ExecutionPolicyOptions } from "../../../executionRole";
import { retryWhileRoleUnassumable } from "../../../harness";
import { resolveAwsAccount } from "../cdk/environment";
import {
  readDeployedState,
  removeTargetState,
  updateTargetState,
  type HarnessState,
} from "../../deployedState";
import { readHarnessDirectory, type HarnessDirectory } from "../../harnessDir";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "../types";
import {
  buildCreateHarnessRequest,
  buildUpdateHarnessRequest,
  harnessRequestHash,
  validateForImperativeDeploy,
} from "./harnessRequest";
import { stableStringify } from "./hash";
import type { ExecutionRoleProvisioner } from "./types";

export type { ExecutionRoleProvisioner, ExecutionRoleState } from "./types";

/** The harness control-plane calls a deploy needs, narrowed from CoreHarnessClient. */
export type HarnessCalls = Pick<
  CoreHarnessClient,
  "createHarness" | "updateHarness" | "getHarness" | "listHarnesses" | "deleteHarness"
>;

export type ImperativeBackendConfig = {
  logger: Logger;
  json?: ReadWriteJson;
  harness: HarnessCalls;
  /**
   * Provisions/refreshes the default execution role. Required rather than
   * defaulted, like CdkBackendConfig.identity: a caller that forgets one fails
   * to compile instead of silently getting a client that talks to IAM.
   */
  executionRoles: ExecutionRoleProvisioner;
  /** STS lookup used to verify the active credentials belong to the target's account. */
  resolveAccount?: (region: string) => Promise<string>;
  /** Plan execution knobs, for tests. */
  plan?: Pick<ExecutePlanOptions, "sleep" | "pollIntervalMs" | "stepTimeoutMs" | "now">;
  /** Per-attempt idempotency tokens; injected so fixtures stay stable. */
  newClientToken?: () => string;
};

/**
 * What the steps for one harness learn and hand to each other: the "shared
 * data" of lightpress, typed. Written by the steps, read back by the backend to
 * record state after the plan, whether or not it succeeded.
 */
type HarnessData = {
  harnessId?: string;
  harnessArn?: string;
  executionRoleArn?: string;
  /** The hash of the request the service last reached READY with. */
  appliedRequestHash?: string;
  /** The hash of the request this deploy last issued, applied once READY is observed. */
  issuedRequestHash?: string;
  /** Set once the delete step for a harness no longer in the spec observes it gone. */
  deleted?: boolean;
};

type DeclaredHarness = HarnessDirectory & { entry: HarnessRegistryEntry };

function isNotFound(error: unknown): boolean {
  return (error as Error)?.name === "ResourceNotFoundException";
}

/**
 * Deploys a harness-only project by calling the control plane directly: no
 * CloudFormation, no CDK toolchain. Each deploy builds a plan (see
 * src/core/plan) with one create/update subtree per declared harness and one
 * delete root per harness the state still records, then walks it. Because
 * every step reads before it writes, re-running converges: an unchanged spec
 * issues no call, a harness deleted out of band is recreated, a killed run
 * resumes from what the service reports.
 */
export class ImperativeBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly json: ReadWriteJson;
  private readonly harness: HarnessCalls;
  private readonly executionRoles: ExecutionRoleProvisioner;
  private readonly resolveAccount: (region: string) => Promise<string>;
  private readonly planOptions: ImperativeBackendConfig["plan"];
  private readonly newClientToken: () => string;

  constructor(config: ImperativeBackendConfig) {
    this.logger = config.logger;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.harness = config.harness;
    this.executionRoles = config.executionRoles;
    this.resolveAccount = config.resolveAccount ?? ((region) => resolveAwsAccount(region));
    this.planOptions = config.plan;
    this.newClientToken = config.newClientToken ?? (() => randomUUID());
  }

  // There is nothing to synthesize: the deploy reads harness.json straight into
  // API requests. `project build` still routes by managedBy, so this is only
  // reached through the manager's mode-aware paths.
  public async *build(): AsyncGenerator<ProjectEvent, void> {
    yield {
      type: "step",
      message: "Nothing to build: imperative deploy calls the service directly",
    };
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { type: "step", message: `Verifying AWS account ${target.account}` };
    const account = await this.verifyAccount(target);
    const options: CoreOptions = { region: target.region };

    // Everything that can fail on local input fails here, before any AWS call.
    yield { type: "step", message: "Reading harness configuration" };
    const declared = await this.readDeclaredHarnesses(project);
    const recorded =
      (await readDeployedState(this.json, project.rootPath)).targets[target.name]?.resources
        ?.harnesses ?? {};

    if (declared.length === 0) {
      return yield* this.teardown(project, input, recorded, options);
    }

    yield { type: "step", message: "Resolving harness identities" };
    const data = await this.resolveIdentities(declared, recorded, options);

    const plan: Plan = { name: `${project.name}/${target.name}`, steps: [] };
    for (const harness of declared) {
      plan.steps.push(
        this.harnessSubtree(harness, data.get(harness.spec.name)!, {
          account,
          options,
        }),
      );
    }
    const removed = Object.keys(recorded).filter(
      (name) => !declared.some((harness) => harness.spec.name === name),
    );
    for (const name of removed) {
      const state: HarnessData = { harnessId: recorded[name]!.harnessId };
      data.set(name, state);
      plan.steps.push(this.deleteStep(name, state, options));
    }

    try {
      yield* executePlan(plan, { ...this.planOptions, logger: this.logger });
    } finally {
      // Recorded even after a failure: a harness created moments before an
      // error is still ours, and the next deploy must find it by id rather
      // than by name.
      await this.recordState(project, target, recorded, data);
    }

    const outputs: Record<string, string> = {};
    for (const harness of declared) {
      const state = data.get(harness.spec.name)!;
      outputs[`harness.${harness.spec.name}.id`] = state.harnessId!;
      outputs[`harness.${harness.spec.name}.arn`] = state.harnessArn!;
    }
    return { outputs };
  }

  /**
   * Removes every harness the target still records, for a deploy of a project
   * that declares nothing. Mirrors CdkBackend.teardown: refuse when there is
   * nothing to remove, ask, then remove and forget the target.
   */
  private async *teardown(
    project: Project,
    input: DeployBackendInput,
    recorded: Record<string, HarnessState>,
    options: CoreOptions,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    const names = Object.keys(recorded);
    if (names.length === 0) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, and no harness is ` +
          `recorded for target '${target.name}' in ${target.account}/${target.region} to remove. ` +
          `Add a resource — for example 'agentcore project add harness' — before deploying.`,
      );
    }

    const description =
      names.length === 1
        ? `harness '${names[0]}'`
        : `harnesses ${names.map((name) => `'${name}'`).join(", ")}`;
    const confirmed = await input.confirmTeardown({
      projectName: project.name,
      targetName: target.name,
      resourceDescription: description,
      account: target.account,
      region: target.region,
    });
    if (!confirmed) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, so deploying to target ` +
          `'${target.name}' would delete ${description}. Re-run with --yes to confirm, or ` +
          `restore the resources the project should have.`,
      );
    }

    const data = new Map<string, HarnessData>();
    const plan: Plan = { name: `${project.name}/${target.name}/teardown`, steps: [] };
    for (const name of names) {
      const state: HarnessData = { harnessId: recorded[name]!.harnessId };
      data.set(name, state);
      plan.steps.push(this.deleteStep(name, state, options));
    }

    try {
      yield* executePlan(plan, { ...this.planOptions, logger: this.logger });
    } catch (error) {
      await this.recordState(project, target, recorded, data);
      throw error;
    }
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  /**
   * The subtree for one declared harness:
   *
   *   [execution-role] ──► [put-harness]
   *
   * The role step is omitted for a user-supplied role, which is used as-is and
   * never modified; put-harness is then the subtree's root.
   */
  private harnessSubtree(
    harness: DeclaredHarness,
    data: HarnessData,
    context: { account: string; options: CoreOptions },
  ): Step {
    const put = this.putHarnessStep(harness, data, context.options);
    if (harness.spec.executionRoleArn) {
      data.executionRoleArn = harness.spec.executionRoleArn;
      return put;
    }
    return { ...this.executionRoleStep(harness, data, context), next: [put] };
  }

  private executionRoleStep(
    harness: DeclaredHarness,
    data: HarnessData,
    { account, options }: { account: string; options: CoreOptions },
  ): Step {
    const name = harness.spec.name;
    const policyOptions = this.executionPolicyOptions(harness);
    const desired = stableStringify(
      desiredExecutionPolicy(options.region, account, name, policyOptions),
    );
    return {
      name: `harness/${name}/execution-role`,
      status: async () => {
        const role = await this.executionRoles.describe(name, options.region);
        if (!role?.policyDocument) return "NOT_STARTED";
        let attached: unknown;
        try {
          attached = JSON.parse(role.policyDocument);
        } catch {
          return "NOT_STARTED";
        }
        if (stableStringify(attached) !== desired) return "NOT_STARTED";
        data.executionRoleArn = role.roleArn;
        return "SUCCESSFUL";
      },
      do: async () => {
        data.executionRoleArn = await this.executionRoles.ensure(
          name,
          options.region,
          policyOptions,
        );
      },
    };
  }

  /** What this harness's spec adds to the baseline execution policy. */
  protected executionPolicyOptions(harness: DeclaredHarness): ExecutionPolicyOptions {
    return { managedMemory: harness.spec.memory?.mode === "managed" };
  }

  private putHarnessStep(harness: DeclaredHarness, data: HarnessData, options: CoreOptions): Step {
    const name = harness.spec.name;
    const desiredRequest = (): CreateHarnessRequest => {
      // The role ARN is known only once the role step has run (or was supplied).
      if (!data.executionRoleArn) {
        throw new ProjectStateError(
          `Harness '${name}' has no execution role ARN to deploy with; the execution-role step did not report one.`,
        );
      }
      return buildCreateHarnessRequest(
        harness.spec,
        harness.systemPrompt,
        data.executionRoleArn,
        this.extraSkills(harness),
      );
    };

    return {
      name: `harness/${name}/put-harness`,
      status: async () => {
        if (!data.harnessId) return "NOT_STARTED";
        let current: Harness | undefined;
        try {
          current = (await this.harness.getHarness(data.harnessId, options)).harness;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          // Deleted out from under us: forget the id so `do` recreates it.
          this.logger
            .child({ harnessName: name, harnessId: data.harnessId })
            .warn("recorded harness no longer exists; it will be recreated");
          data.harnessId = undefined;
          data.harnessArn = undefined;
          data.appliedRequestHash = undefined;
          return "NOT_STARTED";
        }
        if (!current) {
          throw new MalformedServiceResponseError(
            `GetHarness returned no harness for '${data.harnessId}'`,
          );
        }
        data.harnessArn = current.arn ?? data.harnessArn;
        switch (current.status) {
          case "CREATING":
          case "UPDATING":
            return "WAITING";
          case "CREATE_FAILED":
            throw new ProjectStateError(
              `Harness '${name}' (${data.harnessId}) failed to create` +
                (current.failureReason ? `: ${current.failureReason}` : "") +
                `. Delete it with 'agentcore harness delete --id ${data.harnessId}' and redeploy.`,
            );
          case "UPDATE_FAILED":
            // An update can be retried; the engine's attempt cap bounds it.
            this.logger
              .child({ harnessName: name, failureReason: current.failureReason })
              .warn("harness update failed; retrying");
            return "NOT_STARTED";
          case "DELETING":
          case "DELETE_FAILED":
            throw new ProjectStateError(
              `Harness '${name}' (${data.harnessId}) is ${current.status}; wait for the ` +
                `deletion to finish (or resolve it) and redeploy.`,
            );
          case "READY": {
            const hash = harnessRequestHash(desiredRequest());
            if (data.issuedRequestHash === hash || data.appliedRequestHash === hash) {
              data.appliedRequestHash = hash;
              return "SUCCESSFUL";
            }
            return "NOT_STARTED";
          }
          default:
            throw new MalformedServiceResponseError(
              `Harness '${name}' reports an unknown status '${current.status}'`,
            );
        }
      },
      do: async () => {
        const request = desiredRequest();
        const hash = harnessRequestHash(request);
        if (!data.harnessId) {
          // A fresh default role may not be assumable yet; the service reports
          // that as a validation error, which the retry waits out.
          const created = await retryWhileRoleUnassumable(() =>
            this.harness.createHarness({ ...request, clientToken: this.newClientToken() }, options),
          );
          if (!created.harness?.harnessId || !created.harness.arn) {
            throw new MalformedServiceResponseError(
              `CreateHarness returned no harness id for '${name}'`,
            );
          }
          data.harnessId = created.harness.harnessId;
          data.harnessArn = created.harness.arn;
        } else {
          await this.harness.updateHarness(
            {
              ...buildUpdateHarnessRequest(
                data.harnessId,
                harness.spec,
                harness.systemPrompt,
                request.executionRoleArn!,
                this.extraSkills(harness),
              ),
              clientToken: this.newClientToken(),
            },
            options,
          );
        }
        data.issuedRequestHash = hash;
      },
    };
  }

  /** Skills the deploy adds beyond harness.json. None yet. */
  protected extraSkills(_harness: DeclaredHarness): ServiceHarnessSkill[] {
    return [];
  }

  private deleteStep(name: string, data: HarnessData, options: CoreOptions): Step {
    return {
      name: `delete-harness/${name}`,
      status: async () => {
        let current: Harness | undefined;
        try {
          current = (await this.harness.getHarness(data.harnessId!, options)).harness;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          data.deleted = true;
          return "SUCCESSFUL";
        }
        return current?.status === "DELETING" ? "WAITING" : "NOT_STARTED";
      },
      do: async () => {
        await this.harness.deleteHarness(
          { harnessId: data.harnessId!, clientToken: this.newClientToken() },
          options,
        );
      },
    };
  }

  private async verifyAccount(target: AwsDeploymentTarget): Promise<string> {
    const account = await this.resolveAccount(target.region);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }
    return account;
  }

  private async readDeclaredHarnesses(project: Project): Promise<DeclaredHarness[]> {
    const declared: DeclaredHarness[] = [];
    for (const entry of project.spec.harnesses) {
      const read = await readHarnessDirectory(this.json, project.rootPath, entry);
      validateForImperativeDeploy(read.spec);
      declared.push({ ...read, entry });
    }
    // Adoption keys on the service's harness name, so two names that differ
    // only by case would be an ambiguous match waiting to happen.
    const byLowerName = new Map<string, string>();
    for (const { spec } of declared) {
      const other = byLowerName.get(spec.name.toLowerCase());
      if (other) {
        throw new ProjectStateError(
          `Harnesses '${other}' and '${spec.name}' differ only by case; the imperative deploy ` +
            `matches harnesses by name case-insensitively, so rename one of them.`,
        );
      }
      byLowerName.set(spec.name.toLowerCase(), spec.name);
    }
    return declared;
  }

  /**
   * Finds each declared harness's id once, before the plan runs: from the
   * recorded state, else by name among the account's harnesses (adopting one
   * created by an earlier CLI or by hand). Nothing found means the harness does
   * not exist yet and put-harness will create it.
   */
  private async resolveIdentities(
    declared: DeclaredHarness[],
    recorded: Record<string, HarnessState>,
    options: CoreOptions,
  ): Promise<Map<string, HarnessData>> {
    const data = new Map<string, HarnessData>();
    let listed: { harnessId: string; harnessName: string; arn: string }[] | undefined;
    for (const { spec } of declared) {
      const known = recorded[spec.name];
      if (known) {
        data.set(spec.name, {
          harnessId: known.harnessId,
          harnessArn: known.harnessArn,
          appliedRequestHash: known.appliedRequestHash,
        });
        continue;
      }
      listed ??= await this.listAllHarnesses(options);
      const matches = listed.filter(
        (summary) => summary.harnessName.toLowerCase() === spec.name.toLowerCase(),
      );
      if (matches.length > 1) {
        throw new ProjectStateError(
          `Harness '${spec.name}' matches ${matches.length} harnesses in ${options.region} ` +
            `(${matches.map((m) => m.harnessId).join(", ")}). Delete or rename the extras so ` +
            `the name identifies one harness, then redeploy.`,
        );
      }
      const match = matches[0];
      if (match) {
        this.logger
          .child({ harnessName: spec.name, harnessId: match.harnessId })
          .info("adopting an existing harness by name");
      }
      data.set(spec.name, match ? { harnessId: match.harnessId, harnessArn: match.arn } : {});
    }
    return data;
  }

  private async listAllHarnesses(
    options: CoreOptions,
  ): Promise<{ harnessId: string; harnessName: string; arn: string }[]> {
    const all: { harnessId: string; harnessName: string; arn: string }[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.harness.listHarnesses(nextToken, undefined, options);
      for (const summary of page.harnesses ?? []) {
        if (summary.harnessId && summary.harnessName && summary.arn) {
          all.push({
            harnessId: summary.harnessId,
            harnessName: summary.harnessName,
            arn: summary.arn,
          });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return all;
  }

  /**
   * Writes what the steps learned back to deployed-state.json. The harnesses
   * map is replaced wholesale: a declared harness with an id is (re)recorded,
   * one whose delete step saw it gone is dropped, and anything else the target
   * recorded is kept as it was.
   */
  private async recordState(
    project: Project,
    target: AwsDeploymentTarget,
    recorded: Record<string, HarnessState>,
    data: Map<string, HarnessData>,
  ): Promise<void> {
    const next: Record<string, HarnessState> = { ...recorded };
    for (const [name, state] of data) {
      if (state.deleted) {
        delete next[name];
        continue;
      }
      if (!state.harnessId || !state.harnessArn) continue;
      next[name] = {
        ...recorded[name],
        harnessId: state.harnessId,
        harnessArn: state.harnessArn,
        ...(state.executionRoleArn && { executionRoleArn: state.executionRoleArn }),
        ...(state.appliedRequestHash && { appliedRequestHash: state.appliedRequestHash }),
      };
    }
    await updateTargetState(this.json, project.rootPath, target.name, {
      deploymentMode: "imperative",
      resources: { harnesses: next },
    });
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target } = input;
    const recorded = (await readDeployedState(this.json, project.rootPath)).targets[target.name]
      ?.resources?.harnesses;
    if (!recorded) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }
    const options: CoreOptions = { region: target.region };
    const resources: ResolvedDeployedResource[] = [];
    for (const { name } of project.spec.harnesses) {
      const id = recorded[name]?.harnessId;
      if (id && (await this.harnessExists(id, options))) {
        resources.push({ resourceType: "harness", name, id, target });
      }
    }
    return resources;
  }

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const { target } = input;
    const recorded =
      (await readDeployedState(this.json, project.rootPath)).targets[target.name]?.resources
        ?.harnesses ?? {};
    const options: CoreOptions = { region: target.region };
    const resources: ResolvedProjectResource[] = [];
    for (const { name } of project.spec.harnesses) {
      const id = recorded[name]?.harnessId;
      resources.push(
        id && (await this.harnessExists(id, options))
          ? { resourceType: "harness", name, deploymentState: "deployed", id }
          : { resourceType: "harness", name, deploymentState: "local-only" },
      );
    }
    return resources;
  }

  private async harnessExists(id: string, options: CoreOptions): Promise<boolean> {
    try {
      await this.harness.getHarness(id, options);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
