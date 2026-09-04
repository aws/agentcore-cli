import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  discoverSkills,
  skillsBucketName,
  skillsManifest,
  skillsPrefix,
  skillUri,
  validateSkills,
  type LocalSkill,
} from "./skillsDir";

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harnessDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentcore-skills-"));
  tempDirectories.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

describe("discoverSkills", () => {
  test("yields nothing for a harness without a skills directory", async () => {
    expect(await discoverSkills(await harnessDir({ "harness.json": "{}" }))).toEqual([]);
  });

  test("yields nothing for a skills directory holding only the README", async () => {
    const dir = await harnessDir({ "skills/README.md": "# Skills" });
    expect(await discoverSkills(dir)).toEqual([]);
  });

  test("lists one skill per subdirectory with its files walked, hashed, and sorted", async () => {
    const dir = await harnessDir({
      "skills/README.md": "# Skills",
      "skills/pdf-tools/SKILL.md": "# PDF",
      "skills/pdf-tools/scripts/extract.py": "print('x')",
      "skills/pdf-tools/scripts/a.py": "a",
      "skills/release-notes/SKILL.md": "# Notes",
    });

    const skills = await discoverSkills(dir);

    expect(skills.map((s) => s.name)).toEqual(["pdf-tools", "release-notes"]);
    expect(skills[0]?.path).toBe(join(dir, "skills", "pdf-tools"));
    expect(skills[0]?.files).toEqual([
      {
        relativePath: "SKILL.md",
        absolutePath: join(dir, "skills", "pdf-tools", "SKILL.md"),
        md5: md5("# PDF"),
        size: 5,
      },
      {
        relativePath: "scripts/a.py",
        absolutePath: join(dir, "skills", "pdf-tools", "scripts", "a.py"),
        md5: md5("a"),
        size: 1,
      },
      {
        relativePath: "scripts/extract.py",
        absolutePath: join(dir, "skills", "pdf-tools", "scripts", "extract.py"),
        md5: md5("print('x')"),
        size: 10,
      },
    ]);
  });

  test("skips junk and dotfiles at every level, and dot-directories as skills", async () => {
    const dir = await harnessDir({
      "skills/tool/SKILL.md": "# T",
      "skills/tool/.DS_Store": "junk",
      "skills/tool/.env": "secret",
      "skills/tool/__pycache__/x.pyc": "bytes",
      "skills/tool/.git/config": "cfg",
      "skills/tool/lib/.hidden": "h",
      "skills/tool/lib/ok.txt": "ok",
      "skills/.hidden-skill/SKILL.md": "# hidden",
      "skills/__pycache__/SKILL.md": "# cache",
    });

    const skills = await discoverSkills(dir);

    expect(skills.map((s) => s.name)).toEqual(["tool"]);
    expect(skills[0]?.files.map((f) => f.relativePath)).toEqual(["SKILL.md", "lib/ok.txt"]);
  });
});

describe("validateSkills", () => {
  const uriOf = (skill: LocalSkill) => skillUri("bkt", "p/h/skills/", skill.name);
  const skill = (name: string, files: string[], size = 1): LocalSkill => ({
    name,
    path: `/x/${name}`,
    files: files.map((relativePath) => ({
      relativePath,
      absolutePath: `/x/${name}/${relativePath}`,
      md5: "0",
      size,
    })),
  });

  test("accepts well-formed skills", () => {
    expect(() =>
      validateSkills("h", [skill("pdf-tools", ["SKILL.md", "a/b.txt"])], { skills: [] }, uriOf),
    ).not.toThrow();
  });

  test("reports every problem at once", () => {
    let message = "";
    try {
      validateSkills(
        "h",
        [
          skill("NoManifest", ["notes.md"]),
          skill("too-big", ["SKILL.md"], 5 * 1024 * 1024 * 1024 + 1),
          skill("dup", ["SKILL.md"]),
        ],
        { skills: [{ s3Uri: "s3://bkt/p/h/skills/dup/" }] },
        uriOf,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Harness 'h' has skills the deploy cannot upload");
    expect(message).toContain("'skills/NoManifest': skill directory names must match");
    expect(message).toContain("'skills/NoManifest': missing SKILL.md");
    expect(message).toContain("'skills/too-big/SKILL.md'");
    expect(message).toContain("exceeds the 5 GB single-upload limit");
    expect(message).toContain("'skills/dup': harness.json already lists its URI");
  });

  test.each(["ok", "a.b_c-d", "0start", "x".repeat(64)])("accepts the name %s", (name) => {
    expect(() =>
      validateSkills("h", [skill(name, ["SKILL.md"])], { skills: [] }, uriOf),
    ).not.toThrow();
  });

  test.each(["Upper", "has space", "-lead", ".lead", "x".repeat(65), "sl/ash"])(
    "rejects the name %s",
    (name) => {
      expect(() => validateSkills("h", [skill(name, ["SKILL.md"])], { skills: [] }, uriOf)).toThrow(
        /skill directory names must match/,
      );
    },
  );
});

describe("naming", () => {
  test("bucket, prefix, and URI follow the documented shapes", () => {
    expect(skillsBucketName("111122223333", "us-east-1")).toBe(
      "agentcore-skills-111122223333-us-east-1",
    );
    expect(skillsBucketName("111122223333", "ap-southeast-2").length).toBeLessThanOrEqual(63);
    expect(skillsPrefix("MyProject", "support")).toBe("MyProject/support/skills/");
    expect(skillUri("bkt", "MyProject/support/skills/", "pdf-tools")).toBe(
      "s3://bkt/MyProject/support/skills/pdf-tools/",
    );
  });

  test("the manifest keys every file under the prefix", () => {
    const manifest = skillsManifest("p/h/skills/", [
      {
        name: "a",
        path: "/x/a",
        files: [
          { relativePath: "SKILL.md", absolutePath: "/x/a/SKILL.md", md5: "1", size: 1 },
          { relativePath: "lib/b.txt", absolutePath: "/x/a/lib/b.txt", md5: "2", size: 2 },
        ],
      },
    ]);
    expect([...manifest.keys()]).toEqual(["p/h/skills/a/SKILL.md", "p/h/skills/a/lib/b.txt"]);
    expect(manifest.get("p/h/skills/a/lib/b.txt")?.md5).toBe("2");
  });
});
