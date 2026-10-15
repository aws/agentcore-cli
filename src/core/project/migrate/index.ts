import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import semver from "semver";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import { FsReadWriteJson, runProcess, type ProcessRunner, type ReadWriteJson } from "../../../io";
import type { Logger } from "../../../logging";
import type {
  MigrationApplyOptions,
  MigrationCheck,
  MigrationPlan,
  MigrationPlanOptions,
  MigrationProblem,
  MigrationResult,
  PinnedName,
  PreparedMigration,
  ProjectMigrator,
  SkippedStackPlan,
} from "../../../handlers/project/migrate/types";
import {
  AwsDeploymentTargetsSchema,
  type AwsDeploymentTarget,
} from "../../../projectSchemas/aws-targets";
import type { V0DeployedState } from "../../../projectSchemas/v0";
import { createCloudFormationClient } from "../../factories";
import type { CreateCloudFormationClient } from "../../types";
import { stackArtifactForTarget } from "../backends/cdk/assembly";
import { resolveAwsAccount, type AccountResolver } from "../backends/cdk/environment";
import {
  createCdkCredentialResolver,
  type CdkCredentialProvider,
  type CdkCredentialResolver,
} from "../backends/cdk/toolkit";
import { defaultSource, type AssetSource } from "../source";
import { FsTreeNode } from "../templates/fsTree";
import { applyMigration, physicalIds, undoInterruptedMigration, type ApplyTarget } from "./apply";
import { BACKUP_RELATIVE_PATH } from "./files";
import {
  readMigrationState,
  STATE_RELATIVE_PATH,
  type JournalTarget,
  type MigrationState,
} from "./journal";
import { convertHarness } from "./convertHarness";
import { checkGitGate } from "./gitGate";
import {
  AWS_TARGETS_RELATIVE_PATH,
  convertSpec,
  convertTargets,
  SPEC_RELATIVE_PATH,
} from "./convertSpec";
import { planStack, type PlannedStack } from "./plan";
import { describe as describeRefactor, type PollOptions } from "./refactor";
import { preflight } from "./preflight";
import { RETAINED_GUIDANCE } from "./retain";
import { saveMigrationReport } from "./reports";
import { checkStack, cloudFormationStackReader } from "./stacks";
import {
  CDK_LIBRARY_OVERRIDE_ENV,
  createWorkspaceSynthesizer,
  librarySpec,
  type WorkspaceSynthesizer,
} from "./synth";
import type { CfnTemplate } from "./templates";
import { bootstrapBucketStore, type TemplateStore } from "./templateStore";
import { appBuildsHarnessContainers } from "./v0CdkApp";
import { buildMigrationWorkspace, type MigrationWorkspace } from "./workspace";

export { CDK_LIBRARY_OVERRIDE_ENV } from "./synth";
export { REPORTS_RELATIVE_PATH } from "./reports";

/** Just enough of a synthesized template to know it is one; the rest is read as is. */
const TemplateSchema = z.looseObject({ Resources: z.record(z.string(), z.unknown()).optional() });

export type FsProjectMigratorConfig = {
  logger: Logger;
  /** Runs git (and, through the default synthesizer, npm); injectable so tests never spawn processes. */
  runner?: ProcessRunner;
  /** Where v1's vended CDK app is read from. */
  assetSource?: AssetSource;
  /** Builds the CloudFormation client the deployed stacks are read through. */
  createCloudFormationClient?: CreateCloudFormationClient;
  /** Resolves the AWS credentials a target's stack is read with. */
  resolveCredentials?: CdkCredentialResolver;
  /** The account behind those credentials, checked against the target's. */
  resolveAccount?: AccountResolver;
  /** Installs and synthesizes the v1 CDK app in the migration workspace. */
  synthesize?: WorkspaceSynthesizer;
  /** Read for {@link CDK_LIBRARY_OVERRIDE_ENV}; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** How stack refactors are polled; injectable so tests don't wait. */
  poll?: PollOptions;
  /** Builds the store large templates are uploaded to; defaults to the CDK bootstrap bucket. */
  templateStore?: (target: AwsDeploymentTarget) => TemplateStore;
};

/** A deployment target with a deployed stack, and what planning has read about it. */
export type DeployedTarget = {
  target: AwsDeploymentTarget;
  stackName: string;
  /** Set once the stack passed its checks and its template was read. */
  template?: CfnTemplate;
  /** The client the stack was read through, for refactoring it later. */
  client?: CloudFormationClient;
  credentials?: CdkCredentialProvider;
  /** Why the stack couldn't be read, when it couldn't. */
  skipReason?: string;
};

/** A planned stack, with what refactoring it needs. */
type PlannedTarget = DeployedTarget & { planned: PlannedStack };

/**
 * The first `@aws/agentcore-cdk` release whose naming honors `migratedFrom: "v1"`.
 * A migrated project deploys with the library pinned in the CLI's vended CDK app
 * (src/assets/cdk/package.json), so migrating with an older one would let the
 * first v1 deploy replace every migrated resource. Raised with the library
 * release that adds migratedFrom, together with the vended pin.
 */
export const MIN_MIGRATED_FROM_CDK_VERSION = "1.0.0-rc.4";

const CDK_LIBRARY = "@aws/agentcore-cdk";

/**
 * What a CDK library without `migratedFrom` support says when it validates the
 * converted agentcore.json: its project schema rejects unknown keys.
 */
const UNSUPPORTED_MIGRATED_FROM = /migratedFrom/;

/**
 * Plans a v0 → v1 migration from the project on disk. Planning reads the project,
 * builds the converted copy in a temporary directory, and synthesizes it; from
 * AWS it only reads the deployed stacks. It never writes to the project or to AWS.
 */
export class FsProjectMigrator implements ProjectMigrator {
  private readonly runner: ProcessRunner;
  private readonly assetSource: AssetSource;
  private readonly json: ReadWriteJson;
  private readonly createCloudFormationClient: CreateCloudFormationClient;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly synthesize: WorkspaceSynthesizer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly poll?: PollOptions;
  private readonly templateStore?: (target: AwsDeploymentTarget) => TemplateStore;

  constructor(config: FsProjectMigratorConfig) {
    this.runner = config.runner ?? runProcess;
    this.assetSource = config.assetSource ?? defaultSource();
    this.json = new FsReadWriteJson({ logger: config.logger });
    this.createCloudFormationClient =
      config.createCloudFormationClient ?? createCloudFormationClient;
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.env = config.env ?? process.env;
    this.synthesize =
      config.synthesize ?? createWorkspaceSynthesizer({ runner: this.runner, env: this.env });
    if (config.poll) this.poll = config.poll;
    if (config.templateStore) this.templateStore = config.templateStore;
  }

  public async plan(rootPath: string, options: MigrationPlanOptions = {}): Promise<MigrationPlan> {
    const prepared = await this.prepare(rootPath, options);
    try {
      return prepared.plan;
    } finally {
      await prepared.dispose();
    }
  }

  public async hasPendingMigration(rootPath: string): Promise<boolean> {
    return existsSync(join(rootPath, STATE_RELATIVE_PATH));
  }

  public async saveReport(rootPath: string, fileName: string, contents: string): Promise<string> {
    return saveMigrationReport(rootPath, fileName, contents);
  }

  public async prepare(
    rootPath: string,
    options: MigrationPlanOptions = {},
  ): Promise<PreparedMigration> {
    const state = await readMigrationState(rootPath);
    if (state) return this.prepareFinishPending(rootPath, state, options);

    const { checks, context } = await preflight(rootPath, this.runner);
    if (!context) {
      return notApplicable({
        rootPath,
        checks,
        problems: [],
        deployedChanges: [],
        pins: [],
        warnings: [],
        changes: [],
        stacks: [],
        skippedStacks: [],
        pendingTargets: [],
        ready: false,
      });
    }
    const { v0Spec, deployedState } = context;

    const harnesses = await Promise.all(
      v0Spec.harnesses.map((entry) => convertHarness(rootPath, entry)),
    );
    // The v0 app builds a harness's container (and its ECR repository) itself only
    // from v0.16.0, which passes the library hasDockerfile and the code location.
    const buildsContainers = await appBuildsHarnessContainers(rootPath);
    const converted = convertSpec(
      v0Spec,
      deployedState,
      Object.fromEntries(
        harnesses.flatMap(({ name, directory, facts }) =>
          facts
            ? [
                [
                  name,
                  {
                    ...facts,
                    hasDockerfile: buildsContainers && facts.dockerfile !== undefined,
                    ...(facts.dockerfile !== undefined && { codeLocation: directory }),
                  },
                ] as const,
              ]
            : [],
        ),
      ),
    );
    const targets = await this.readTargets(rootPath);
    const problems: MigrationProblem[] = [
      ...converted.problems,
      ...harnesses.flatMap((harness) => harness.problems),
      ...targets.problems,
    ];

    const override = this.env[CDK_LIBRARY_OVERRIDE_ENV]?.trim();
    const cdkLibraryOverride = override ? librarySpec(override, process.cwd()) : undefined;
    const library = await this.libraryCheck(cdkLibraryOverride);
    checks.push(library.check);

    const deployed = deployedTargets(v0Spec.name, targets.targets, deployedState);
    checks.push(...deployed.checks);
    const skippedStacks: SkippedStackPlan[] = deployed.skipped;
    const selection = selectTarget(deployed.targets, options.target, "deployed");
    if (selection.check) checks.push(selection.check);
    const { selected } = selection;
    if (selected) await this.readSelectedStack(selected, checks, skippedStacks, options);

    const warnings = [
      ...converted.warnings,
      ...harnesses.flatMap((harness) => harness.warnings),
      ...sharedEnvironmentWarnings(targets.targets),
      ...credentialNameWarnings(v0Spec.credentials.map((credential) => credential.name)),
      ...library.warnings,
      ...overrideWarnings(cdkLibraryOverride),
    ];

    const workspace = await buildMigrationWorkspace({
      rootPath,
      spec: converted.json,
      harnesses: harnesses.flatMap(({ directory, yaml }) =>
        yaml === undefined ? [] : [{ directory, yaml }],
      ),
      assetSource: this.assetSource,
    });
    try {
      // The selected stack is planned whatever else failed, so one run shows
      // everything; only a project that doesn't convert can't synthesize.
      let planned: PlannedTarget | undefined;
      if (selected?.template !== undefined && problems.length > 0) {
        skippedStacks.push({
          reason:
            "the project doesn't convert to v1 until the issues under 'Fix before migrating' are fixed",
        });
      } else if (selected?.template !== undefined) {
        const result = await this.planStacks(
          workspace.directory,
          [selected],
          checks,
          converted.pins,
          options,
        );
        planned = result.planned[0];
        skippedStacks.push(...result.skipped);
      }
      const stacks = planned ? [planned.planned.plan] : [];
      const plan: MigrationPlan = {
        rootPath,
        projectName: v0Spec.name,
        checks,
        problems,
        deployedChanges: converted.deployedChanges,
        pins: converted.pins,
        warnings,
        changes: workspace.changes,
        stacks,
        skippedStacks,
        ...(cdkLibraryOverride !== undefined && { cdkLibraryOverride }),
        ...(selected && { selectedTarget: selected.target.name }),
        pendingTargets: selection.others.map((entry) => entry.target.name),
        ready:
          checks.every((check) => check.ok) &&
          problems.length === 0 &&
          converted.deployedChanges.length === 0 &&
          skippedStacks.length === 0 &&
          stacks.every((stack) => stack.ready),
      };
      const state: MigrationState = {
        version: 2,
        startedAt: new Date().toISOString(),
        files: { status: "writing", backup: BACKUP_RELATIVE_PATH, changes: plan.changes },
        refactored: [],
        targets: [...(selected ? [selected] : []), ...selection.others].map(pendingTarget),
      };
      return this.prepared(
        plan,
        async (applyOptions) => {
          // The plan reported the git check; it's enforced again here, since the
          // tree may have changed while the user read the plan.
          await checkGitGate(this.runner, plan.rootPath);
          return applyMigration(
            {
              rootPath,
              state,
              files: {
                workspaceDirectory: workspace.directory,
                writeCdkApp: (cdkDirectory) => this.writeVendedCdkApp(cdkDirectory),
              },
              ...(planned && { target: this.applyTarget(planned) }),
              runner: this.runner,
              ...(this.poll && { poll: this.poll }),
            },
            applyOptions,
          );
        },
        workspace,
      );
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  /** A plan with what applying it needs; applying refuses a plan that isn't ready. */
  private prepared(
    plan: MigrationPlan,
    apply: (options: MigrationApplyOptions) => Promise<MigrationResult>,
    workspace: MigrationWorkspace | undefined,
  ): PreparedMigration {
    return {
      plan,
      apply: async (options: MigrationApplyOptions = {}): Promise<MigrationResult> => {
        if (!plan.ready) {
          throw new ProjectStateError("This migration plan isn't ready, so it can't be applied.");
        }
        return apply(options);
      },
      dispose: async () => {
        await workspace?.dispose();
      },
    };
  }

  private applyTarget(entry: PlannedTarget): ApplyTarget {
    const { target, stackName, planned } = entry;
    let store: TemplateStore | undefined;
    return {
      target,
      stackName,
      renames: planned.renames,
      ...(planned.bridge && { bridge: planned.bridge }),
      ...(planned.retain && { retain: planned.retain }),
      client: entry.client!,
      templates: async () =>
        (store ??=
          this.templateStore?.(target) ??
          bootstrapBucketStore({
            cloudFormation: entry.client!,
            credentials: entry.credentials!,
            region: target.region,
          })),
    };
  }

  /** Reads the selected target's stack, recording why it was skipped when it can't be. */
  private async readSelectedStack(
    entry: DeployedTarget,
    checks: MigrationCheck[],
    skippedStacks: SkippedStackPlan[],
    options: MigrationPlanOptions,
  ): Promise<void> {
    options.onStep?.(
      `Reading stack ${entry.stackName} (${entry.target.account}/${entry.target.region})`,
    );
    const check = await this.readStack(entry);
    checks.push(check);
    if (entry.template === undefined) {
      skippedStacks.push({ target: entry.target.name, reason: entry.skipReason ?? check.message });
    }
  }

  /** v1's vended CDK app, exactly as this CLI ships it (never an overridden library). */
  private async writeVendedCdkApp(cdkDirectory: string): Promise<void> {
    const cdkApp = await FsTreeNode.fromAssetSource(
      { assetSource: this.assetSource },
      { assetDir: "cdk" },
    );
    await cdkApp.write(dirname(cdkDirectory));
  }

  /**
   * Whether the CDK library this CLI vends keeps v0 names for a project marked
   * migratedFrom. Without it the first deploy after migrating would replace every
   * migrated resource, so it blocks the migration; with the library overridden
   * for testing it only warns, loudly.
   */
  private async libraryCheck(
    override: string | undefined,
  ): Promise<{ check: MigrationCheck; warnings: string[] }> {
    const name = "cdk library";
    let vended: string | undefined;
    try {
      const manifest = JSON.parse(await this.assetSource.read("cdk/package.json")) as {
        dependencies?: Record<string, string>;
      };
      vended = manifest.dependencies?.[CDK_LIBRARY];
    } catch {
      vended = undefined;
    }
    const version = vended
      ? (semver.valid(vended.trim().replace(/^[~^=]/, "")) ?? undefined)
      : undefined;
    const supported = version !== undefined && semver.gte(version, MIN_MIGRATED_FROM_CDK_VERSION);
    if (supported) {
      return {
        check: {
          name,
          ok: true,
          message: `${CDK_LIBRARY} ${vended} keeps v0 names (migratedFrom)`,
        },
        warnings: [],
      };
    }
    const unsupported =
      `This CLI's v1 CDK app uses ${CDK_LIBRARY} ${vended ?? "(unknown)"}, which doesn't keep v0 ` +
      `resource names (migratedFrom needs ${MIN_MIGRATED_FROM_CDK_VERSION} or later)`;
    if (override !== undefined) {
      return {
        check: {
          name,
          ok: true,
          message: `planned with ${CDK_LIBRARY} from ${CDK_LIBRARY_OVERRIDE_ENV} (${override})`,
        },
        warnings: [
          `${CDK_LIBRARY_OVERRIDE_ENV} is set, for testing only. ${unsupported}. Migrating writes ` +
            `that app into the project; install a ${CDK_LIBRARY} with migratedFrom in agentcore/cdk ` +
            "before you deploy, or the first deploy replaces the project's resources.",
        ],
      };
    }
    return {
      check: {
        name,
        ok: false,
        message:
          `${unsupported}, so the first deploy after migrating would replace this project's ` +
          "resources. Run `agentcore update`, then run `agentcore migrate` again.",
        summary:
          `This CLI can't keep this project's resource names yet (it vends ${CDK_LIBRARY} ` +
          `${vended ?? "(unknown)"}; migrating needs ${MIN_MIGRATED_FROM_CDK_VERSION} or later). ` +
          "Run `agentcore update`, then run `agentcore migrate` again.",
      },
      warnings: [],
    };
  }

  /**
   * Plans finishing a pending migration, from scratch like any other run. A run
   * stopped while writing the project files is undone: the plan puts the v0 files
   * back. Otherwise the project files are already v1: a refactor the record says
   * was running is checked with CloudFormation first, and then the selected pending
   * target is planned fresh, from the current project and its still-v0 stack.
   */
  private async prepareFinishPending(
    rootPath: string,
    state: MigrationState,
    options: MigrationPlanOptions,
  ): Promise<PreparedMigration> {
    const projectName = await this.projectName(rootPath);
    if (state.files?.status === "writing") {
      const plan: MigrationPlan = {
        rootPath,
        ...(projectName !== undefined && { projectName }),
        checks: [
          {
            name: "interrupted migration",
            ok: true,
            message:
              "an earlier `agentcore migrate` stopped while writing the project files, so " +
              `they are part v0 and part v1. Applying puts the v0 files back from ` +
              `${BACKUP_RELATIVE_PATH}; then run \`agentcore migrate\` again.`,
          },
        ],
        problems: [],
        deployedChanges: [],
        pins: [],
        warnings: [],
        changes: state.files.changes,
        stacks: [],
        skippedStacks: [],
        pendingTargets: [],
        undoInterrupted: true,
        ready: true,
      };
      return this.prepared(plan, () => undoInterruptedMigration(rootPath, state), undefined);
    }

    const checks: MigrationCheck[] = [];
    const skippedStacks: SkippedStackPlan[] = [];
    const completed: string[] = [];
    const pending: DeployedTarget[] = [];
    for (const entry of state.targets) {
      const deployed = deployedFromRecord(entry);
      if (entry.status === "refactoring" && entry.refactorId) {
        options.onStep?.(`Checking the refactor of stack ${entry.stackName} (${entry.refactorId})`);
        const reconciled = await this.reconcile(deployed, entry);
        checks.push(reconciled.check);
        if (reconciled.outcome === "completed") {
          completed.push(entry.name);
          continue;
        }
        if (reconciled.outcome === "blocked") {
          skippedStacks.push({ target: entry.name, reason: reconciled.check.message });
          continue;
        }
      }
      pending.push(deployed);
    }
    checks.unshift({
      name: "pending migration",
      ok: true,
      message:
        `finishing a pending migration of this project: ${state.targets.length} ` +
        `${state.targets.length === 1 ? "target isn't" : "targets aren't"} migrated yet ` +
        `(${state.targets.map((entry) => entry.name).join(", ")})`,
    });

    const selection = selectTarget(pending, options.target, "pending");
    if (selection.check) checks.push(selection.check);
    const { selected } = selection;

    const override = this.env[CDK_LIBRARY_OVERRIDE_ENV]?.trim();
    const cdkLibraryOverride = override ? librarySpec(override, process.cwd()) : undefined;
    const warnings = overrideWarnings(cdkLibraryOverride);
    let planned: PlannedTarget | undefined;
    let workspace: MigrationWorkspace | undefined;
    if (selected) {
      const library = await this.libraryCheck(cdkLibraryOverride);
      checks.push(library.check);
      warnings.unshift(...library.warnings);
      await this.readSelectedStack(selected, checks, skippedStacks, options);
    }
    try {
      if (selected?.template !== undefined) {
        workspace = await buildMigrationWorkspace({
          rootPath,
          spec: JSON.parse(await readFile(join(rootPath, SPEC_RELATIVE_PATH), "utf8")),
          harnesses: [],
          assetSource: this.assetSource,
        });
        const result = await this.planStacks(workspace.directory, [selected], checks, [], options);
        planned = result.planned[0];
        skippedStacks.push(...result.skipped);
      }
      const stacks = planned ? [planned.planned.plan] : [];
      const plan: MigrationPlan = {
        rootPath,
        ...(projectName !== undefined && { projectName }),
        checks,
        problems: [],
        deployedChanges: [],
        pins: [],
        warnings,
        changes: [],
        stacks,
        skippedStacks,
        ...(cdkLibraryOverride !== undefined && { cdkLibraryOverride }),
        finishPending: true,
        ...(selected && { selectedTarget: selected.target.name }),
        pendingTargets: selection.others.map((entry) => entry.target.name),
        ready:
          checks.every((check) => check.ok) &&
          skippedStacks.length === 0 &&
          stacks.every((stack) => stack.ready),
      };
      return this.prepared(
        plan,
        (applyOptions) =>
          applyMigration(
            {
              rootPath,
              state,
              completed,
              ...(planned && { target: this.applyTarget(planned) }),
              runner: this.runner,
              ...(this.poll && { poll: this.poll }),
            },
            applyOptions,
          ),
        workspace,
      );
    } catch (error) {
      await workspace?.dispose();
      throw error;
    }
  }

  /**
   * Reads back the refactor the record says was running when an earlier run
   * stopped: finished (and every resource under its v1 logical ID), known not to
   * have run (the target is pending again), or neither, which needs a person.
   */
  private async reconcile(
    entry: DeployedTarget,
    recorded: JournalTarget,
  ): Promise<{ outcome: "completed" | "pending" | "blocked"; check: MigrationCheck }> {
    const { target, stackName } = entry;
    const name = `refactor (${target.name})`;
    const id = recorded.refactorId!;
    const commands =
      `Check it with \`aws cloudformation describe-stack-refactor --stack-refactor-id ${id} ` +
      `--region ${target.region}\` and \`aws cloudformation list-stack-resources --stack-name ` +
      `${stackName} --region ${target.region}\`.`;
    try {
      const credentials = await this.resolveCredentials(target.region);
      const account = await this.resolveAccount(target.region, credentials);
      if (account !== target.account) {
        return {
          outcome: "blocked",
          check: { name, ok: false, message: accountMismatch(target, account) },
        };
      }
      const client = this.createCloudFormationClient({ credentials, region: target.region });
      const refactor = await describeRefactor(client, id);
      const status = refactor.ExecutionStatus;
      if (status === "EXECUTE_COMPLETE") {
        const ids = await physicalIds(client, stackName);
        const renames = recorded.renames ?? [];
        const misplaced = renames.filter(([from, to]) => ids.has(from) || !ids.has(to));
        if (misplaced.length > 0) {
          return {
            outcome: "blocked",
            check: {
              name,
              ok: false,
              message:
                `Refactor ${id} of stack ${stackName} finished, but ${misplaced.length} ` +
                `${misplaced.length === 1 ? "resource isn't" : "resources aren't"} under the ` +
                `planned logical ID (${misplaced.map(([from, to]) => `${from} → ${to}`).join(", ")}). ${commands}`,
            },
          };
        }
        return {
          outcome: "completed",
          check: { name, ok: true, message: `refactor ${id} of ${stackName} finished` },
        };
      }
      if (status?.endsWith("_IN_PROGRESS")) {
        return {
          outcome: "blocked",
          check: {
            name,
            ok: false,
            message:
              `Refactor ${id} of stack ${stackName} is still running (${status}). Wait for it ` +
              `to finish, then run agentcore migrate --target ${target.name} again. ${commands}`,
          },
        };
      }
      if (
        status === "AVAILABLE" ||
        status === "EXECUTE_FAILED" ||
        status === "ROLLBACK_COMPLETE" ||
        refactor.Status === "CREATE_FAILED"
      ) {
        return {
          outcome: "pending",
          check: {
            name,
            ok: true,
            message: `refactor ${id} of ${stackName} didn't run (${status ?? refactor.Status}); it's planned again`,
          },
        };
      }
      return {
        outcome: "blocked",
        check: {
          name,
          ok: false,
          message:
            `Refactor ${id} of stack ${stackName} ended ${status ?? "with no status"}` +
            `${refactor.ExecutionStatusReason ? ` (${refactor.ExecutionStatusReason})` : ""}, so ` +
            `whether it moved anything isn't known. ${commands}`,
        },
      };
    } catch (error) {
      return {
        outcome: "blocked",
        check: {
          name,
          ok: false,
          message: `Couldn't read refactor ${id} of stack ${stackName}: ${(error as Error).message}. ${commands}`,
        },
      };
    }
  }

  /** The project's name for the report; the project gate already read the spec. */
  private async projectName(rootPath: string): Promise<string | undefined> {
    try {
      const spec = JSON.parse(await readFile(join(rootPath, SPEC_RELATIVE_PATH), "utf8")) as {
        name?: unknown;
      };
      return typeof spec.name === "string" ? spec.name : undefined;
    } catch {
      return undefined;
    }
  }

  private async readTargets(
    rootPath: string,
  ): Promise<{ targets: AwsDeploymentTarget[]; problems: MigrationProblem[] }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(rootPath, AWS_TARGETS_RELATIVE_PATH), "utf8"));
    } catch (error) {
      return {
        targets: [],
        problems: [
          {
            file: AWS_TARGETS_RELATIVE_PATH,
            path: "(file)",
            message: `Couldn't read it: ${(error as Error).message}`,
          },
        ],
      };
    }
    const parsed = AwsDeploymentTargetsSchema.safeParse(raw);
    return { targets: parsed.success ? parsed.data : [], problems: convertTargets(raw) };
  }

  /**
   * Checks one deployed target's stack with the target's credentials, and reads
   * its deployed template when the stack can be refactored. AWS errors become a
   * failed check, so one plan still reports everything.
   */
  private async readStack(entry: DeployedTarget): Promise<MigrationCheck> {
    const { target, stackName } = entry;
    try {
      const credentials = await this.resolveCredentials(target.region);
      const account = await this.resolveAccount(target.region, credentials);
      if (account !== target.account) {
        entry.skipReason = accountMismatch(target, account);
        return { name: `stack (${target.name})`, ok: false, message: entry.skipReason };
      }
      const client = this.createCloudFormationClient({ credentials, region: target.region });
      const reader = cloudFormationStackReader(client);
      const check = await checkStack(reader, target.name, stackName);
      if (check.ok) {
        entry.template = await reader.template(stackName);
        entry.client = client;
        entry.credentials = credentials;
      }
      return check;
    } catch (error) {
      return {
        name: `stack (${target.name})`,
        ok: false,
        message: `Couldn't read stack '${stackName}' in ${target.account}/${target.region}: ${(error as Error).message}`,
      };
    }
  }

  private async planStacks(
    workspaceDirectory: string,
    targets: DeployedTarget[],
    checks: MigrationCheck[],
    pins: PinnedName[],
    options: MigrationPlanOptions,
  ): Promise<{ planned: PlannedTarget[]; skipped: SkippedStackPlan[] }> {
    let assemblyDirectory: string;
    try {
      assemblyDirectory = await this.synthesize(workspaceDirectory, options);
    } catch (error) {
      const detail = (error as Error).message;
      checks.push({
        name: "v1 synth",
        ok: false,
        message: UNSUPPORTED_MIGRATED_FROM.test(detail)
          ? "The CDK library the v1 app synthesized with doesn't support migratedFrom yet, so it " +
            "can't keep this project's v0 resource names. Plan again with an @aws/agentcore-cdk " +
            `release that supports migratedFrom.\n${detail}`
          : `The converted project's v1 CDK app didn't synthesize:\n${detail}`,
      });
      return {
        planned: [],
        skipped: [
          {
            reason: "the converted project's v1 CDK app didn't synthesize (see the v1 synth check)",
          },
        ],
      };
    }
    checks.push({ name: "v1 synth", ok: true, message: "the converted project synthesizes" });

    const planned: PlannedTarget[] = [];
    const skipped: SkippedStackPlan[] = [];
    for (const entry of targets) {
      const { target, stackName, template } = entry;
      options.onStep?.(`Planning the refactor of ${stackName}`);
      try {
        const artifact = await stackArtifactForTarget(this.json, assemblyDirectory, target.name);
        if (artifact.templateFile === undefined) {
          throw new ProjectStateError(
            `Stack artifact '${artifact.id}' names no template file in the v1 cloud assembly.`,
          );
        }
        const v1 = (await this.json.read(
          join(assemblyDirectory, artifact.templateFile),
          TemplateSchema,
        )) as CfnTemplate;
        const stack = await planStack({
          target,
          stackName,
          // Only targets whose stack was read are planned.
          deployed: template!,
          v1,
          v1StackName: artifact.stackName,
          pins: pins.filter((pin) => pin.targets.includes(target.name)),
        });
        if (stack.plan.retained && entry.client) {
          // The plan names what it keeps by physical ID, so the user can find it later.
          const ids = await physicalIds(entry.client, stackName);
          for (const resource of stack.plan.retained) {
            const physicalId = ids.get(resource.logicalId);
            if (physicalId) resource.physicalId = physicalId;
            const guidance = RETAINED_GUIDANCE[resource.type];
            if (guidance) resource.guidance = guidance;
          }
        }
        planned.push({ ...entry, planned: stack });
      } catch (error) {
        // One target that can't be planned still leaves the rest of the report.
        const message = `Couldn't plan the refactor of '${stackName}': ${(error as Error).message}`;
        checks.push({ name: `plan (${target.name})`, ok: false, message });
        skipped.push({ target: target.name, reason: message });
      }
    }
    return { planned, skipped };
  }
}

/** A plan that can't be applied, with nothing to clean up. */
function notApplicable(plan: MigrationPlan): PreparedMigration {
  return {
    plan,
    apply: () => {
      throw new ProjectStateError("This migration plan isn't ready, so it can't be applied.");
    },
    dispose: async () => {},
  };
}

/**
 * Targets that share an AWS account and region. A migrated project keeps v0's
 * physical names, which have no target segment, so such targets claim the same
 * resource names: only one of them can be deployed, as with the v0 CLI.
 */
export function sharedEnvironmentWarnings(targets: AwsDeploymentTarget[]): string[] {
  const byEnvironment = new Map<string, string[]>();
  for (const target of targets) {
    const key = `${target.account}/${target.region}`;
    byEnvironment.set(key, [...(byEnvironment.get(key) ?? []), target.name]);
  }
  return [...byEnvironment]
    .filter(([, names]) => names.length > 1)
    .map(
      ([environment, names]) =>
        `Targets '${names.join("', '")}' are all in ${environment}. A migrated project keeps v0's ` +
        "resource names, which have no target segment, so these targets claim the same names " +
        "and only one of them can be deployed (as with the v0 CLI). Move the others to another " +
        "account or region.",
    );
}

/**
 * Credential providers aren't stack resources: the CLI provisions them, and a
 * migrated project must keep v0's bare provider names, which the CLI's
 * provisioning does only for projects it treats as v0.
 */
export function credentialNameWarnings(names: string[]): string[] {
  if (names.length === 0) return [];
  return [
    `This project has credentials (${names.join(", ")}). The migrated project keeps v0's ` +
      "credential provider names (the bare credential names) and, like a v0 project, never " +
      "deletes its API key or OAuth providers, since other v0 projects may share them.",
  ];
}

/**
 * The deployment targets that have a deployed stack: those the deployed state
 * records resources for. A deployed target missing from aws-targets.json can't be
 * planned (its account and region are unknown, and the v1 app wouldn't
 * synthesize its stack), so it fails a check.
 */
export function deployedTargets(
  projectName: string,
  targets: AwsDeploymentTarget[],
  state: V0DeployedState,
): { targets: DeployedTarget[]; checks: MigrationCheck[]; skipped: SkippedStackPlan[] } {
  const checks: MigrationCheck[] = [];
  const deployed: DeployedTarget[] = [];
  const skipped: SkippedStackPlan[] = [];
  for (const [name, recorded] of Object.entries(state.targets)) {
    if (recorded.resources === undefined) continue;
    const target = targets.find((candidate) => candidate.name === name);
    if (!target) {
      const message =
        `The deployed state records a deployment to target '${name}', which isn't in ` +
        `${AWS_TARGETS_RELATIVE_PATH}. Add the target back, or tear its stack down with the ` +
        "v0 CLI first.";
      checks.push({ name: `stack (${name})`, ok: false, message });
      skipped.push({ target: name, reason: message });
      continue;
    }
    deployed.push({
      target,
      // v0 records the stack name; older deploys derive it the same way v1 does.
      stackName:
        recorded.resources.stackName ??
        `AgentCore-${projectName.replace(/_/g, "-")}-${name.replace(/_/g, "-")}`,
    });
  }
  return { targets: deployed, checks, skipped };
}

/**
 * Picks the one deployment target a run migrates. One candidate is picked
 * automatically; several need `--target`, and the rest stay pending. `kind` says
 * what the candidates are, for the messages.
 */
export function selectTarget(
  candidates: DeployedTarget[],
  requested: string | undefined,
  kind: "deployed" | "pending",
): { selected?: DeployedTarget; others: DeployedTarget[]; check?: MigrationCheck } {
  const names = candidates.map((entry) => entry.target.name);
  const described = kind === "deployed" ? "is deployed to" : "has pending migrations for";
  if (requested !== undefined) {
    const selected = candidates.find((entry) => entry.target.name === requested);
    if (!selected) {
      return {
        others: candidates,
        check: {
          name: "target",
          ok: false,
          message:
            names.length === 0
              ? `--target ${requested}: this project ${kind === "deployed" ? "isn't deployed to any target" : "has no pending targets"}.`
              : `--target ${requested}: this project ${described} ${names.map((name) => `'${name}'`).join(", ")}, not '${requested}'.`,
        },
      };
    }
    return {
      selected,
      others: candidates.filter((entry) => entry !== selected),
      check: targetCheck(selected, candidates),
    };
  }
  if (candidates.length <= 1) {
    const [selected] = candidates;
    return { ...(selected && { selected, check: targetCheck(selected, candidates) }), others: [] };
  }
  return {
    others: candidates,
    check: {
      name: "target",
      ok: false,
      message:
        `This project ${described} ${candidates.length} targets (${names.join(", ")}). ` +
        "Migrate one target at a time: run `agentcore migrate --target <name>`.",
    },
  };
}

function targetCheck(selected: DeployedTarget, candidates: DeployedTarget[]): MigrationCheck {
  const others = candidates.filter((entry) => entry !== selected).map((entry) => entry.target.name);
  return {
    name: "target",
    ok: true,
    message:
      `migrating '${selected.target.name}' (${selected.target.account}/${selected.target.region})` +
      (others.length > 0
        ? `; ${others.join(", ")} ${others.length === 1 ? "stays" : "stay"} pending until migrated with --target`
        : ""),
  };
}

function accountMismatch(target: AwsDeploymentTarget, active: string): string {
  return (
    `Target '${target.name}' is in AWS account ${target.account} (${target.region}), but the ` +
    `active credentials belong to account ${active}. Switch to credentials for account ` +
    `${target.account} and run \`agentcore migrate --target ${target.name}\` again.`
  );
}

function overrideWarnings(cdkLibraryOverride: string | undefined): string[] {
  return cdkLibraryOverride === undefined
    ? []
    : [
        `Synthesized with @aws/agentcore-cdk from ${CDK_LIBRARY_OVERRIDE_ENV} ` +
          `(${cdkLibraryOverride}), not the library this CLI vends; the plan holds only for that library.`,
      ];
}

function pendingTarget(entry: DeployedTarget): JournalTarget {
  return {
    name: entry.target.name,
    account: entry.target.account,
    region: entry.target.region,
    stackName: entry.stackName,
    status: "pending",
  };
}

function deployedFromRecord(entry: JournalTarget): DeployedTarget {
  return {
    target: {
      name: entry.name,
      account: entry.account,
      region: entry.region as AwsDeploymentTarget["region"],
    },
    stackName: entry.stackName,
  };
}
