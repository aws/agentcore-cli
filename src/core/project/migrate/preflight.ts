import { SPEC_RELATIVE_PATH } from "./convertSpec";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProcessRunner } from "../../../io";
import type { MigrationCheck } from "../../../handlers/project/migrate/types";
import {
  V0AgentCoreProjectSpecSchema,
  V0DeployedStateSchema,
  type V0DeployedState,
  type V0ProjectSpec,
} from "../../../projectSchemas/v0";
import { projectFormat } from "../legacy/detect";
import { DEPLOYED_STATE_RELATIVE_PATH } from "../backends/cdk/deployedState";
import { checkGitGate } from "./gitGate";
import { checkCdkApp } from "./v0CdkApp";

/**
 * Checks that run before planning, so a project that can't migrate (not v0, not in
 * git, an app or dependency migrate doesn't recognize, resources v1 can't keep)
 * gets a clear reason up front rather than a failed or lossy migration.
 */
/** The CDK app's manifest, relative to the project root. */
export const CDK_APP_RELATIVE_PATH = "agentcore/cdk";
export const CDK_PACKAGE_RELATIVE_PATH = "agentcore/cdk/package.json";

/** The first `@aws/agentcore-cdk` release the v0.24.2 CLI vended; older apps can't be migrated. */
const MIN_CDK_ALPHA = 45;
const CDK_PIN_PATTERN = /^0\.1\.0-alpha\.(\d+)$/;

export const OLD_CDK_MESSAGE =
  "This project's CDK dependencies are older than v0.24.2. Run `npx @aws/agentcore@0 deploy` " +
  "once to update them, then try again.";

/** What later steps need from a project that passed the format check. */
export type PreflightContext = {
  v0Spec: V0ProjectSpec;
  /** Empty when the project was never deployed. */
  deployedState: V0DeployedState;
};

export type PreflightResult = {
  checks: MigrationCheck[];
  /** Absent when the project could not be read as a v0 project; nothing else can run. */
  context?: PreflightContext;
};

/**
 * Checks whether a project can be migrated. Every check runs, so one plan shows
 * everything to fix, except when agentcore.json isn't a v0 project at all.
 */
export async function preflight(rootPath: string, runner: ProcessRunner): Promise<PreflightResult> {
  const format = await checkProjectFormat(rootPath);
  if (!format.v0Spec) return { checks: [format.check] };

  const deployed = await checkDeployedState(rootPath);
  return {
    checks: [
      format.check,
      await checkGit(rootPath, runner),
      await checkCdkPin(rootPath),
      await checkCdkApp(rootPath),
      checkSupportedResources(format.v0Spec),
      deployed.check,
    ],
    context: { v0Spec: format.v0Spec, deployedState: deployed.state },
  };
}

/** The project's agentcore.json must be a valid v0 (version 1) spec. */
export async function checkProjectFormat(
  rootPath: string,
): Promise<{ check: MigrationCheck; v0Spec?: V0ProjectSpec }> {
  const fail = (message: string) => ({ check: { name: "v0 project", ok: false, message } });
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(rootPath, SPEC_RELATIVE_PATH), "utf8"));
  } catch (error) {
    return fail(`Couldn't read ${SPEC_RELATIVE_PATH}: ${(error as Error).message}`);
  }
  const version =
    typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version === 2) {
    return fail(
      "This project is already a v1 project (agentcore.json version 2); there is nothing to migrate.",
    );
  }
  if (projectFormat(raw) !== "v0") {
    return fail(
      `${SPEC_RELATIVE_PATH} has version ${JSON.stringify(version)}; only v0 projects (version 1) can be migrated.`,
    );
  }
  const parsed = V0AgentCoreProjectSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      `${SPEC_RELATIVE_PATH} isn't a valid v0 project. Fix it with the v0 CLI first:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    check: { name: "v0 project", ok: true, message: `'${parsed.data.name}' is a v0 project` },
    v0Spec: parsed.data,
  };
}

/**
 * The git gate `agentcore migrate` applies before changing anything (git
 * installed, the project in a work tree with agentcore.json committed and nothing
 * uncommitted), reported as a check so a plan lists it with everything else.
 */
export async function checkGit(rootPath: string, runner: ProcessRunner): Promise<MigrationCheck> {
  try {
    await checkGitGate(runner, rootPath);
    return { name: "git", ok: true, message: "working tree is clean" };
  } catch (error) {
    return { name: "git", ok: false, message: (error as Error).message };
  }
}

/** The project's CDK app must pin an `@aws/agentcore-cdk` new enough to migrate from. */
export async function checkCdkPin(rootPath: string): Promise<MigrationCheck> {
  const name = "cdk dependencies";
  let manifest: { dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(
      await readFile(join(rootPath, CDK_PACKAGE_RELATIVE_PATH), "utf8"),
    ) as typeof manifest;
  } catch (error) {
    return {
      name,
      ok: false,
      message: `Couldn't read ${CDK_PACKAGE_RELATIVE_PATH}: ${(error as Error).message}`,
    };
  }
  const pin = manifest.dependencies?.["@aws/agentcore-cdk"];
  if (typeof pin === "string" && isLocalSpec(pin)) {
    // A local build isn't old, it just isn't a release: comparing versions would mislead.
    return {
      name,
      ok: false,
      message:
        `${CDK_APP_RELATIVE_PATH} uses a local @aws/agentcore-cdk build (${pin}), not the v0 ` +
        "release the project was created with, so migrate can't tell what it deployed. Put " +
        `the released dependency back (for example, \`git checkout -- ${CDK_PACKAGE_RELATIVE_PATH} ` +
        `${CDK_APP_RELATIVE_PATH}/package-lock.json\`, then \`npm install\` in ${CDK_APP_RELATIVE_PATH}), ` +
        "and run `agentcore migrate` again.",
    };
  }
  const match = typeof pin === "string" ? CDK_PIN_PATTERN.exec(pin) : null;
  if (!match || Number(match[1]) < MIN_CDK_ALPHA) {
    return { name, ok: false, message: OLD_CDK_MESSAGE };
  }
  return { name, ok: true, message: `@aws/agentcore-cdk ${String(pin)}` };
}

/** A dependency spec that points at a build on disk or a tarball rather than a published release. */
function isLocalSpec(spec: string): boolean {
  return /^(file:|link:|\.{1,2}\/|\/|~\/)/.test(spec.trim()) || /\.tgz$/.test(spec.trim());
}

/** v0 online eval configs that run insights, which migrate leaves outside the v1 project. */
export function onlineInsightConfigs(v0: V0ProjectSpec): V0ProjectSpec["onlineEvalConfigs"] {
  return v0.onlineEvalConfigs.filter((config) => config.insights !== undefined);
}

/**
 * The guide to keeping resources a migration can't carry over (docs CR-309021468).
 * The final page ID is TBD until the guide is published; this is the expected location.
 */
export const PRESERVE_RESOURCES_DOCS_URL =
  "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/preserve-resources.html";

/**
 * The resources migrating can't carry over, so the user hears about them before
 * anything changes rather than finding them broken after. Knowledge bases,
 * datasets, and insights-only online evals are retained outside the stack, so
 * they don't block. Capacity providers do: runtimes run on them, and v1 can't run
 * a runtime on one yet.
 */
export function checkSupportedResources(v0: V0ProjectSpec): MigrationCheck {
  const name = "supported resources";
  const runtimesOnCapacityProviders = v0.runtimes
    .filter(
      (runtime) =>
        runtime.capacityProviderConfiguration !== undefined ||
        (runtime.filesystemConfigurations ?? []).some((mount) => "capacityProviderVolume" in mount),
    )
    .map((runtime) => runtime.name);
  const capacityProviders = (v0.capacityProviders ?? []).map((provider) => provider.name);

  const listed = [
    capacityProviders.length > 0 ? `capacity providers (${capacityProviders.join(", ")})` : "",
    runtimesOnCapacityProviders.length > 0
      ? `runtimes on capacity providers (${runtimesOnCapacityProviders.join(", ")})`
      : "",
  ].filter(Boolean);
  if (listed.length === 0) {
    return { name, ok: true, message: "no capacity providers or runtimes on them" };
  }

  const summary = `Migration blocked: This project uses resources that v1 doesn't support yet: ${listed.join("; ")}.`;
  const why: string[] = [];
  if (capacityProviders.length > 0 || runtimesOnCapacityProviders.length > 0) {
    why.push(
      "Capacity providers: runtimes run on them, and v1 can't run a runtime on a capacity " +
        "provider yet, so migrating would leave those runtimes without their compute.",
    );
  }
  return {
    name,
    ok: false,
    summary,
    message: [
      summary,
      ...why,
      "Keep using this project in compatibility mode until v1 supports them; nothing in it " +
        "needs to change.",
      `See ${PRESERVE_RESOURCES_DOCS_URL}`,
    ].join("\n"),
  };
}

/** The v0 deployed state, which says which resources already exist in AWS. */
export async function checkDeployedState(
  rootPath: string,
): Promise<{ check: MigrationCheck; state: V0DeployedState }> {
  const name = "deployed state";
  const empty: V0DeployedState = { targets: {} };
  let text: string;
  try {
    text = await readFile(join(rootPath, DEPLOYED_STATE_RELATIVE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        check: { name, ok: true, message: "never deployed; no names to keep" },
        state: empty,
      };
    }
    return {
      check: {
        name,
        ok: false,
        message: `Couldn't read ${DEPLOYED_STATE_RELATIVE_PATH}: ${(error as Error).message}`,
      },
      state: empty,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      check: {
        name,
        ok: false,
        message: `${DEPLOYED_STATE_RELATIVE_PATH} isn't valid JSON: ${(error as Error).message}`,
      },
      state: empty,
    };
  }
  const parsed = V0DeployedStateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      check: {
        name,
        ok: false,
        message: `${DEPLOYED_STATE_RELATIVE_PATH} isn't valid v0 deployed state:\n${z.prettifyError(parsed.error)}`,
      },
      state: empty,
    };
  }
  const targets = Object.keys(parsed.data.targets);
  return {
    check: {
      name,
      ok: true,
      message: targets.length
        ? `deployed to ${targets.map((t) => `'${t}'`).join(", ")}`
        : "never deployed; no names to keep",
    },
    state: parsed.data,
  };
}
