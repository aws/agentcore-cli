import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ProjectStateError } from "../../errors/errors";
import type { HarnessSpec } from "../../projectSchemas/harness";

// A harness directory may carry a skills/ directory next to harness.json: one
// subdirectory per skill, each with a SKILL.md and whatever files the skill
// needs. The imperative deploy uploads every skill to S3 and lists it on the
// harness as an s3 skill source; harness.json is never rewritten.

export const SKILLS_DIRECTORY = "skills";
export const SKILL_MANIFEST_FILENAME = "SKILL.md";

/** Safe in an S3 key, in a URI, and unambiguous next to the other skill names. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** S3 accepts one PutObject of up to 5 GB; larger files would need multipart. */
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024 * 1024;

const IGNORED_NAMES = new Set([".DS_Store", "__pycache__", ".git"]);

export type LocalSkillFile = {
  /** Path within the skill directory, forward-slashed, as it becomes the S3 key's tail. */
  relativePath: string;
  absolutePath: string;
  /** Hex MD5, which is the ETag S3 reports for a single-put object. */
  md5: string;
  size: number;
};

export type LocalSkill = {
  name: string;
  /** Absolute path of the skill directory. */
  path: string;
  files: LocalSkillFile[];
};

function ignored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith(".");
}

async function md5Of(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function walk(root: string, directory: string, files: LocalSkillFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (ignored(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolutePath, files);
    } else if (entry.isFile()) {
      const { size } = await stat(absolutePath);
      files.push({
        relativePath: relative(root, absolutePath).split("\\").join("/"),
        absolutePath,
        md5: await md5Of(absolutePath),
        size,
      });
    }
  }
}

/**
 * The skills a harness directory holds: every immediate subdirectory of
 * `skills/`, named after the directory, with its files walked recursively.
 * Files at the top level of `skills/` (its README) are not skills, and a
 * missing directory — projects scaffolded before it existed — yields none.
 * Skills come back sorted by name and files by path, so the manifest built
 * from them is stable.
 */
export async function discoverSkills(harnessDir: string): Promise<LocalSkill[]> {
  const root = join(harnessDir, SKILLS_DIRECTORY);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const skills: LocalSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored(entry.name)) continue;
    const path = join(root, entry.name);
    const files: LocalSkillFile[] = [];
    await walk(path, path, files);
    skills.push({ name: entry.name, path, files });
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Rejects skills the deploy could not upload or the service could not use,
 * listing every problem at once: a directory without SKILL.md, a name that is
 * not S3/URI safe, a file too large for a single PutObject, and a skill whose
 * URI harness.json already lists by hand.
 */
export function validateSkills(
  harnessName: string,
  skills: LocalSkill[],
  spec: Pick<HarnessSpec, "skills">,
  uriOf: (skill: LocalSkill) => string,
): void {
  const problems: string[] = [];
  const declaredUris = new Set(
    spec.skills.flatMap((skill) => ("s3Uri" in skill ? [skill.s3Uri] : [])),
  );
  for (const skill of skills) {
    const label = `${SKILLS_DIRECTORY}/${skill.name}`;
    if (!SKILL_NAME_PATTERN.test(skill.name)) {
      problems.push(
        `'${label}': skill directory names must match ${SKILL_NAME_PATTERN} (lowercase ` +
          `letters, digits, '.', '_' and '-', starting with a letter or digit, at most 64 characters).`,
      );
    }
    if (!skill.files.some((file) => file.relativePath === SKILL_MANIFEST_FILENAME)) {
      problems.push(
        `'${label}': missing ${SKILL_MANIFEST_FILENAME} at the top level of the skill.`,
      );
    }
    for (const file of skill.files) {
      if (file.size > MAX_SKILL_FILE_BYTES) {
        problems.push(
          `'${label}/${file.relativePath}': ${file.size} bytes exceeds the 5 GB single-upload limit.`,
        );
      }
    }
    if (declaredUris.has(uriOf(skill))) {
      problems.push(
        `'${label}': harness.json already lists its URI ${uriOf(skill)} as an s3Uri skill; ` +
          `remove one of the two.`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ProjectStateError(
      `Harness '${harnessName}' has ${problems.length === 1 ? "a skill" : "skills"} the deploy ` +
        `cannot upload:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

/** The bucket an account's skills live in for a region; shared by every project. */
export function skillsBucketName(accountId: string, region: string): string {
  return `agentcore-skills-${accountId}-${region}`;
}

/** The key prefix one harness's skills live under, trailing slash included. */
export function skillsPrefix(projectName: string, harnessName: string): string {
  return `${projectName}/${harnessName}/${SKILLS_DIRECTORY}/`;
}

/** The URI the harness lists a skill under; a trailing slash names the directory. */
export function skillUri(bucket: string, prefix: string, skillName: string): string {
  return `s3://${bucket}/${prefix}${skillName}/`;
}

/** Every object the skills should occupy under `prefix`, keyed by S3 key, with its MD5. */
export function skillsManifest(prefix: string, skills: LocalSkill[]): Map<string, LocalSkillFile> {
  const manifest = new Map<string, LocalSkillFile>();
  for (const skill of skills) {
    for (const file of skill.files) {
      manifest.set(`${prefix}${skill.name}/${file.relativePath}`, file);
    }
  }
  return manifest;
}
