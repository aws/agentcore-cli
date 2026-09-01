import { createInterface } from "node:readline/promises";
import z from "zod";
import { UserCancellationError } from "../../../errors/errors";
import type { AppIO } from "../../../io";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey, RegionKey } from "../../keys";
import type { Project, ProjectManager, TeardownConfirmationHandler } from "../types";

type DeployProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createDeployProjectHandler = (config: DeployProjectHandlerConfig) =>
  createHandler({
    name: "deploy",
    description: "deploy the project to AWS",
    flags: [
      flag(
        "target",
        "name of the aws-targets.json entry to deploy; the default target is created " +
          "automatically from your AWS account and region on first deploy",
        z.string().default(DEFAULT_TARGET_NAME),
      ),
      flag(
        "yes",
        "confirm removing the target's stack when the project declares nothing to deploy",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      // withProject has already resolved the enclosing project.
      const project = ctx.require(ProjectKey);
      const jsonOutput = ctx.require(JsonKey);
      const canPrompt =
        !flags.yes &&
        !jsonOutput &&
        config.io.stdin.isTTY &&
        config.io.stdout.isTTY &&
        config.io.stderr.isTTY;

      // The teardown question is settled here, before the generator starts:
      // once the progress UI is mounted, nothing downstream may block on
      // interactive input.
      const confirmTeardown = await resolveTeardownDecision(
        config,
        project,
        flags.target,
        flags.yes,
        canPrompt === true,
      );

      const deployment = config.projectManager.deploy(project, {
        target: flags.target,
        region: ctx.require(RegionKey),
        confirmTeardown,
      });
      // Progress goes to stderr, keeping stdout for machine output. --json
      // forces the plain path so no ANSI reaches a scripted caller's stderr.
      const result = await runWithProgress(deployment, {
        io: config.io,
        interactive: jsonOutput ? false : undefined,
      });

      config.io.stderr.write(
        result.tornDown
          ? `Removed project '${project.name}' from target '${flags.target}'\n`
          : `Deployed project '${project.name}' to target '${flags.target}'\n`,
      );
      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson(result);
        return;
      }
    },
  });

/**
 * True when the spec declares none of the resources `removeAllResources`
 * clears, i.e. what an emptied project looks like. This is the up-front proxy
 * for the backend's post-synth zero-resource count; the two can disagree when a
 * declared resource synthesizes no CloudFormation resource (or a hand-edited
 * CDK app adds one), so the backend's count stays authoritative and this only
 * decides whether to ask the user before starting.
 */
function declaresNothingDeployable(project: Project): boolean {
  const { spec } = project;
  const collections = [
    spec.runtimes,
    spec.memories,
    spec.knowledgeBases,
    spec.credentials,
    spec.evaluators,
    spec.onlineEvalConfigs,
    spec.agentCoreGateways,
    spec.policyEngines,
    spec.configBundles,
    spec.abTests,
    spec.harnesses,
    spec.mcpRuntimeTools ?? [],
    spec.unassignedTargets ?? [],
    spec.datasets ?? [],
    spec.payments ?? [],
  ];
  return collections.every((collection) => collection.length === 0);
}

/**
 * Resolves the teardown question before the deploy generator starts. The
 * returned handler never blocks on input: it is a pre-answered decision the
 * backend consults if synthesis confirms the deploy would remove the stack.
 */
async function resolveTeardownDecision(
  config: DeployProjectHandlerConfig,
  project: Project,
  targetName: string,
  confirmed: boolean,
  canPrompt: boolean,
): Promise<TeardownConfirmationHandler> {
  if (confirmed) return async () => true;

  if (canPrompt && declaresNothingDeployable(project)) {
    // An undefined target cannot have a stack to tear down: deploy either
    // rejects the name or provisions a fresh default, and the backend then
    // fails with "no stack ... to remove" before consulting the decision.
    const target = await config.projectManager.resolveTarget(project, { target: targetName });
    if (target) {
      if (!(await promptForTeardown(config.io, project.name, target))) {
        throw new UserCancellationError();
      }
      return async () => true;
    }
  }

  // Non-interactive, --json, or the spec-level check missed (see
  // declaresNothingDeployable): the backend's own zero-resource check throws
  // the "re-run with --yes" ProjectStateError when this declines.
  return async () => false;
}

async function promptForTeardown(
  io: AppIO,
  projectName: string,
  target: { name: string; account: string; region: string },
): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    // Asked before synthesis, so the exact stack name is not known yet; the
    // target coordinates identify what would be deleted.
    const answer = await Promise.race([
      readline.question(
        `Project '${projectName}' declares no resources to deploy.\n` +
          `Deploying will delete everything deployed to target ` +
          `'${target.name}' (${target.account}/${target.region}). Continue? (y/N) `,
      ),
      cancelled,
    ]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
