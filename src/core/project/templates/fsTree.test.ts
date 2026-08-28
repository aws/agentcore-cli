import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStateError } from "../../../errors/errors";
import type { AssetSource } from "../source";
import { FsTreeNode } from "./fsTree";

const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-fstree-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FsTreeNode.write", () => {
  test("writes a nested tree to disk", async () => {
    const directory = await inTempDirectory();
    const tree = FsTreeNode.createDirectory(".", [
      FsTreeNode.createDirectory("agentcore", [
        FsTreeNode.createFile("agentcore.json", async () => '{\n  "name": "example"\n}\n'),
      ]),
      FsTreeNode.createDirectory("app", [
        FsTreeNode.createDirectory("hello-world", [
          FsTreeNode.createFile("main.py", async () => "print('hello')\n"),
        ]),
      ]),
    ]);

    await tree.write(directory);

    expect(await readFile(join(directory, "agentcore", "agentcore.json"), "utf8")).toBe(
      '{\n  "name": "example"\n}\n',
    );
    expect(await readFile(join(directory, "app", "hello-world", "main.py"), "utf8")).toBe(
      "print('hello')\n",
    );
  });

  test("refuses to overwrite an existing file", async () => {
    const directory = await inTempDirectory();
    const tree = FsTreeNode.createDirectory(".", [
      FsTreeNode.createFile("README.md", async () => "first\n"),
    ]);

    await tree.write(directory);

    await expect(tree.write(directory)).rejects.toBeInstanceOf(ProjectStateError);
  });
});

describe("FsTreeNode.fromAssetSource", () => {
  test("builds a nested tree from a flat asset listing", async () => {
    const source: AssetSource = {
      async list() {
        return [
          "template/README.md",
          "template/src/main.ts",
          "template/src/util/helpers.ts",
          "template/gitignore.template",
        ];
      },
      async read(assetPath) {
        return `contents:${assetPath}`;
      },
    };

    const tree = await FsTreeNode.fromAssetSource(
      { assetSource: source },
      { assetDir: "template" },
      { rootDirName: "root" },
    );

    expect(tree.name).toBe("root");
    expect(tree.children.map((node) => node.name)).toEqual(["README.md", "src", ".gitignore"]);
    expect(tree.children[1]?.isDir).toBe(true);
    expect(tree.children[1]?.children.map((node) => node.name)).toEqual(["main.ts", "util"]);
    expect(tree.children[1]?.children[1]?.children.map((node) => node.name)).toEqual([
      "helpers.ts",
    ]);
    expect(await tree.children[2]?.bytes?.()).toBe("contents:template/gitignore.template");
  });

  test("transforms content and filters files and directories", async () => {
    const source: AssetSource = {
      async list() {
        return ["template/keep.txt", "template/skip.txt", "template/optional/nested.txt"];
      },
      async read(assetPath) {
        return `contents:${assetPath}`;
      },
    };

    const tree = await FsTreeNode.fromAssetSource(
      { assetSource: source },
      { assetDir: "template" },
      {
        transformContent: (content) => content.toUpperCase(),
        filter: (name, isDir) => name !== "skip.txt" && !(isDir && name === "optional"),
      },
    );

    expect(tree.children.map(({ name }) => name)).toEqual(["keep.txt"]);
    expect(await tree.children[0]?.bytes?.()).toBe("CONTENTS:TEMPLATE/KEEP.TXT");
  });

  test("strips .template suffix from non-ignore files", async () => {
    const source: AssetSource = {
      async list() {
        return ["template/Dockerfile.template", "template/dockerignore.template"];
      },
      async read(assetPath) {
        return `contents:${assetPath}`;
      },
    };

    const tree = await FsTreeNode.fromAssetSource(
      { assetSource: source },
      { assetDir: "template" },
      { rootDirName: "root" },
    );

    expect(tree.children.map((node) => node.name)).toEqual(["Dockerfile", ".dockerignore"]);
  });
});
