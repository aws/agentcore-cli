import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { ProjectStateError } from "../../../../errors/errors";
import type { ProjectEvent } from "../../../../handlers/project/types";
import { createLineSplitter, type ProcessRunner } from "../../../../io";
import type { Logger } from "../../../../logging";
import { withOutputEvents } from "../../events";

type Section = "dependencies" | "devDependencies";

type Manifest = Partial<Record<Section, Record<string, string>>> & Record<string, unknown>;

/** A managed dependency whose declared specifier is rewritten to the one this CLI vends. */
type DependencyChange = { name: string; section: Section; from?: string; to: string };

type DependencyPlan = {
  changes: DependencyChange[];
  /** Managed dependencies the project declares newer than this CLI was released with. */
  newer: { name: string; declared: string; expected: string }[];
  /** Managed dependencies declared with a specifier the sync cannot reason about. */
  skipped: { name: string; declared: string }[];
};

const SECTIONS: Section[] = ["dependencies", "devDependencies"];

const L3_LIBRARY = "@aws/agentcore-cdk";

// node-semver's Range API expands ~ and ^ into comparators, so the base version is read
// directly; anything that is not one version behind an optional prefix is unsupported.
function parseSpecifier(raw: string): semver.SemVer | null {
  const trimmed = raw.trim();
  return semver.parse(/^[~^=]/.test(trimmed) ? trimmed.slice(1) : trimmed);
}

function isNewer(declared: semver.SemVer, expected: semver.SemVer, exact: boolean): boolean {
  // An exact pin (the L3 library) compares fully, prerelease included, so a project a
  // newer CLI moved to 1.2.0 is never silently put back on 1.1.0.
  if (exact) return semver.gt(declared, expected);
  // Ranges float patches, so only a newer major.minor means a newer CLI wrote it.
  if (declared.major !== expected.major) return declared.major > expected.major;
  return declared.minor > expected.minor;
}

/**
 * Compares the project's CDK manifest with the one this CLI vends. Every dependency the
 * vended manifest names is managed; anything else the project declares is left alone.
 */
export function planDependencySync(vended: Manifest, project: Manifest): DependencyPlan {
  const plan: DependencyPlan = { changes: [], newer: [], skipped: [] };
  for (const section of SECTIONS) {
    for (const [name, to] of Object.entries(vended[section] ?? {})) {
      const declaredIn = SECTIONS.find((s) => project[s]?.[name] !== undefined);
      const from = declaredIn && project[declaredIn]?.[name];
      if (!declaredIn || from === undefined) {
        // The vended CDK app cannot synthesize without it.
        plan.changes.push({ name, section, to });
        continue;
      }
      if (from === to) continue;
      const declared = parseSpecifier(from);
      const expected = parseSpecifier(to);
      if (!declared || !expected) {
        // file:, git: and tag specifiers are deliberate local overrides, such as a tarball
        // under test, so they are never rewritten.
        plan.skipped.push({ name, declared: from });
        continue;
      }
      if (isNewer(declared, expected, !/^[~^]/.test(to.trim()))) {
        plan.newer.push({ name, declared: from, expected: to });
        continue;
      }
      plan.changes.push({ name, section: declaredIn, from, to });
    }
  }
  return plan;
}

function formatChanges(changes: DependencyChange[]): string {
  return changes.map(({ name, from, to }) => `${name} ${from ?? "(missing)"} -> ${to}`).join(", ");
}

/**
 * Explains managed pins the project declares newer than this CLI vends. The L3 library
 * moves with the CLI, so the fix is a CLI update; the other pins are the toolchain this
 * CLI is tested with, so the fix is to set them back or opt out.
 */
export function newerPinMessage(newer: DependencyPlan["newer"], vended: Manifest): string {
  const messages: string[] = [];
  const library = newer.find(({ name }) => name === L3_LIBRARY);
  if (library) {
    messages.push(
      `agentcore/cdk/package.json declares ${L3_LIBRARY} ${library.declared}, newer than this ` +
        `AgentCore CLI supports (${library.expected}). Run 'agentcore update', then try again.`,
    );
  }
  const toolchain = newer.filter(({ name }) => name !== L3_LIBRARY);
  if (toolchain.length > 0) {
    // Listed in the order the vended manifest declares them, sections included.
    const managed = Object.entries(vended)
      .filter((entry): entry is [Section, Record<string, string>] =>
        SECTIONS.includes(entry[0] as Section),
      )
      .flatMap(([, deps]) => Object.entries(deps))
      .filter(([name]) => name !== L3_LIBRARY)
      .map(([name, spec]) => `${name} ${spec}`)
      .join(", ");
    const declared = toolchain.map(({ name, declared }) => `${name} ${declared}`).join(", ");
    const setBack =
      toolchain.length === 1
        ? `Set ${toolchain[0]!.name} back to ${toolchain[0]!.expected}`
        : "Set them back to the versions above";
    messages.push(
      `agentcore/cdk/package.json declares ${declared}. The AgentCore CLI manages these CDK ` +
        `dependencies, and they can't be upgraded: ${managed}. ${setBack}, or run ` +
        `'agentcore config disableDependencyManagement true' to manage them yourself.`,
    );
  }
  return messages.join("\n");
}

type SyncCdkDependenciesInput = {
  cdkDirectory: string;
  /** Text of the CDK package.json this CLI vends at create. */
  vendedManifest: string;
  runner: ProcessRunner;
  logger: Logger;
  /** From the global config: leave package.json alone and only warn about newer pins. */
  disabled?: boolean;
  /** Downgrade failures to warnings, so a deploy that removes the stack is never blocked. */
  lenient?: boolean;
};

/**
 * Brings the project's managed CDK dependencies to the versions this CLI release vends.
 *
 * Otherwise only `create` and `migrate` write agentcore/cdk/package.json, so without this a
 * project keeps the L3 library it was created with across CLI upgrades, and any field
 * the newer CLI writes to agentcore.json that the old library does not know is dropped
 * at synth without an error.
 */
export async function* syncCdkDependencies(
  input: SyncCdkDependenciesInput,
): AsyncGenerator<ProjectEvent, void> {
  const manifestPath = join(input.cdkDirectory, "package.json");
  // A project without the vended manifest has no CDK app this sync could keep current;
  // synth reports that on its own.
  if (!existsSync(manifestPath)) return;

  const raw = await readFile(manifestPath, "utf8");
  let project: Manifest;
  try {
    project = JSON.parse(raw) as Manifest;
  } catch (error) {
    throw new ProjectStateError(`Could not parse ${manifestPath}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const vended = JSON.parse(input.vendedManifest) as Manifest;
  const plan = planDependencySync(vended, project);

  for (const { name, declared } of plan.skipped) {
    yield {
      type: "warning",
      message: `${name} (${declared}) in agentcore/cdk/package.json is not a version, so the CLI leaves it as is.`,
    };
  }

  if (plan.newer.length > 0) {
    const message = newerPinMessage(plan.newer, vended);
    if (!input.disabled && !input.lenient) throw new ProjectStateError(message);
    yield { type: "warning", message };
  }

  if (input.disabled) return;
  // A deleted node_modules, or a project created with --skip-install, is installed
  // instead of failing the build, even when the pins already match.
  const installed = existsSync(join(input.cdkDirectory, "node_modules"));
  if (plan.changes.length === 0 && installed) return;

  if (plan.changes.length > 0) {
    // Assigning into the parsed object keeps the user's key order and their own entries.
    for (const { name, section, to } of plan.changes) {
      (project[section] ??= {})[name] = to;
    }
    yield { type: "step", message: `updating CDK dependencies: ${formatChanges(plan.changes)}` };
    await writeFile(manifestPath, `${JSON.stringify(project, undefined, 2)}\n`);
  } else {
    yield { type: "step", message: "installing CDK dependencies (node_modules missing)" };
  }

  try {
    // npm reconciles the edited manifest against the existing lockfile, so dependencies
    // the user added keep their resolved versions.
    yield* withOutputEvents((emit) => {
      const lines = createLineSplitter(emit);
      return input
        .runner(["npm", "install", "--no-audit", "--no-fund"], {
          cwd: input.cdkDirectory,
          onOutput: (chunk) => {
            input.logger.debug(chunk);
            lines.push(chunk);
          },
        })
        .finally(() => lines.flush());
    });
  } catch (error) {
    // Restored so the next run plans the same changes and retries the install, instead of
    // seeing pins that already match and synthesizing against the stale node_modules.
    if (plan.changes.length > 0) {
      try {
        await writeFile(manifestPath, raw);
      } catch (restoreError) {
        yield {
          type: "warning",
          message: `could not restore agentcore/cdk/package.json: ${(restoreError as Error).message}`,
        };
      }
    }
    const message =
      `npm install failed in ${input.cdkDirectory}, so the CDK dependencies could not be ` +
      `installed: ${(error as Error).message}`;
    if (!input.lenient) throw new ProjectStateError(message, { cause: error });
    yield { type: "warning", message };
  }
}
