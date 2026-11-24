import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import z from "zod";
import { DeserializationError, ProjectStateError } from "../../../../errors/errors";
import type { ProjectEvent } from "../../../../handlers/project/types";
import { createLineSplitter, type ProcessRunner, type ReadWriteJson } from "../../../../io";
import type { Logger } from "../../../../logging";
import { withOutputEvents } from "../../events";
import { installedCdkVersion } from "./compatibility";

type Section = "dependencies" | "devDependencies";

const ManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

type Manifest = z.infer<typeof ManifestSchema>;

/** A managed dependency whose declared specifier is rewritten to the one this CLI vends. */
type DependencyChange = { name: string; section: Section; from?: string; to: string };

type DependencyPlan = {
  changes: DependencyChange[];
  /** Managed dependencies the project declares newer than this CLI vends. */
  newer: { name: string; declared: string; expected: string }[];
  /** Managed dependencies declared with a specifier the sync cannot reason about. */
  skipped: { name: string; declared: string }[];
};

const SECTIONS: Section[] = ["dependencies", "devDependencies"];

const L3_LIBRARY = "@aws/agentcore-cdk";

const MANIFEST = "agentcore/cdk/package.json";

/**
 * The version behind a single pinned specifier (`1.2.3`, `~1.2.3`, `^1.2.3`, `=1.2.3`).
 * node-semver's Range API expands ~ and ^ into comparators, so the base version is read
 * directly; anything else, such as `file:`, `>=1.0.0` or `2.x`, is not a single pin.
 */
export function pinnedVersion(spec: string): semver.SemVer | null {
  return semver.parse(spec.trim().replace(/^[~^=]/, ""));
}

function compare(declared: semver.SemVer, expected: semver.SemVer, exact: boolean): number {
  // An exact pin (the L3 library) compares fully, prerelease included, so a project a
  // newer CLI moved to 1.2.0 is never silently put back on 1.1.0.
  if (exact) return semver.compare(declared, expected);
  if (declared.major !== expected.major) return declared.major - expected.major;
  if (declared.minor !== expected.minor) return declared.minor - expected.minor;
  // A higher patch is inside the vended range, and rewriting it down would flip the file
  // back and forth when two CLI releases build the same repo.
  return declared.patch >= expected.patch ? 0 : -1;
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
      const declared = pinnedVersion(from);
      const expected = pinnedVersion(to);
      if (!declared || !expected) {
        // file:, git:, tags and open ranges are deliberate overrides, such as a tarball
        // under test, so they are never rewritten.
        plan.skipped.push({ name, declared: from });
        continue;
      }
      const order = compare(declared, expected, !/^[~^]/.test(to.trim()));
      if (order > 0) plan.newer.push({ name, declared: from, expected: to });
      else if (order < 0) plan.changes.push({ name, section: declaredIn, from, to });
    }
  }
  return plan;
}

function formatChanges(changes: DependencyChange[]): string {
  return changes.map(({ name, from, to }) => `${name} ${from ?? "(missing)"} -> ${to}`).join(", ");
}

/**
 * Explains managed pins the project declares newer than this CLI vends. Only a newer CLI
 * writes a newer L3 pin, and updating to it fixes the toolchain pins too, so those are
 * left out when the L3 pin is newer.
 */
export function newerPinMessage(newer: DependencyPlan["newer"]): string {
  const library = newer.filter(({ name }) => name === L3_LIBRARY);
  const pins = (library.length > 0 ? library : newer).map(
    ({ name, declared, expected }) =>
      `${MANIFEST} pins ${name} ${declared}, newer than the version this CLI vends (${expected}).`,
  );
  return (
    `${pins.join(" ")} Run 'agentcore update', or run ` +
    `'agentcore config disableDependencyManagement true' to manage the CDK dependencies yourself.`
  );
}

/** Writes `manifest` with the indent, line endings and trailing newline found in `raw`. */
function formatLike(raw: string, manifest: unknown): string {
  const indent = /^[ \t]+(?=")/m.exec(raw)?.[0] ?? "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(manifest, undefined, indent).replace(/\n/g, eol);
  return /\r?\n$/.test(raw) ? text + eol : text;
}

type SyncCdkDependenciesInput = {
  cdkDirectory: string;
  /** Text of the CDK package.json this CLI vends at create. */
  vendedManifest: string;
  json: ReadWriteJson;
  runner: ProcessRunner;
  logger: Logger;
  /** From the global config: leave package.json and node_modules alone. */
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

  let project: Manifest;
  try {
    project = await input.json.read(manifestPath, ManifestSchema);
  } catch (error) {
    if (!(error instanceof DeserializationError)) throw error;
    throw new ProjectStateError(error.message, { cause: error });
  }
  const plan = planDependencySync(ManifestSchema.parse(JSON.parse(input.vendedManifest)), project);

  for (const { name, declared } of plan.skipped) {
    yield {
      type: "warning",
      message: `${name} ${declared} in ${MANIFEST} is not a single pinned version, so the CLI leaves it unchanged.`,
    };
  }

  if (input.disabled) {
    const library = plan.changes.find(({ name, from }) => name === L3_LIBRARY && from);
    if (library) {
      yield {
        type: "warning",
        message:
          `${MANIFEST} pins ${L3_LIBRARY} ${library.from}, older than the version this CLI ` +
          `vends (${library.to}). Fields this CLI writes that ${library.from} does not know ` +
          `are dropped at synth. Set it to ${library.to}, or run ` +
          `'agentcore config disableDependencyManagement false' to let the CLI manage it.`,
      };
    }
    return;
  }

  if (plan.newer.length > 0) {
    const message = newerPinMessage(plan.newer);
    if (!input.lenient) throw new ProjectStateError(message);
    yield { type: "warning", message };
  }

  if (plan.changes.length > 0) {
    // Edits the parsed file, not the validated copy, so key order and unknown fields survive.
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<Section, Record<string, string> | undefined>;
    for (const { name, section, to } of plan.changes) {
      (manifest[section] ??= {})[name] = to;
    }
    yield { type: "step", message: `updating CDK dependencies: ${formatChanges(plan.changes)}` };
    await writeFile(manifestPath, formatLike(raw, manifest));
  } else {
    // What is installed decides, not the manifest: a pulled package.json a teammate
    // already synced, or an interrupted install, leaves matching pins over an old library.
    // A newer L3 pin only gets this far on a teardown, which needs no newer library.
    const installed = await installedCdkVersion(input.cdkDirectory);
    const declared = project.dependencies?.[L3_LIBRARY];
    const stale =
      installed === undefined ||
      (declared !== undefined &&
        semver.validRange(declared) !== null &&
        !plan.newer.some(({ name }) => name === L3_LIBRARY) &&
        !semver.satisfies(installed, declared));
    if (!stale) return;
    yield {
      type: "step",
      message:
        installed === undefined
          ? "installing CDK dependencies (node_modules missing)"
          : `installing CDK dependencies (${L3_LIBRARY} ${installed} is installed, ${MANIFEST} pins ${declared})`,
    };
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
    if (!input.lenient) throw error;
    yield { type: "warning", message: (error as Error).message };
  }
}
