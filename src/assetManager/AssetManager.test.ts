import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AssetManager, resolveSourceRoot } from "./AssetManager";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-assets-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AssetManager", () => {
  test("renders a filesystem asset tree", async () => {
    const root = await makeTempDirectory();
    const source = join(root, "assets", "cdk");
    const destination = join(root, "output");

    await mkdir(join(source, "lib"), { recursive: true });
    await Bun.write(join(source, "README.md"), "Hello {{projectName}}");
    await Bun.write(join(source, ".prettierrc"), "{}");
    await Bun.write(join(source, "gitignore.template"), "dist/");
    await Bun.write(join(source, "lib", "stack.ts"), "export const name = '{{projectName}}';");

    await new AssetManager([], join(root, "assets")).render("cdk", destination, {
      projectName: "example",
    });

    expect(await Bun.file(join(destination, "README.md")).text()).toBe("Hello example");
    expect(await Bun.file(join(destination, ".prettierrc")).text()).toBe("{}");
    expect(await Bun.file(join(destination, ".gitignore")).text()).toBe("dist/");
    expect(await Bun.file(join(destination, "lib", "stack.ts")).text()).toBe(
      "export const name = 'example';",
    );
  });

  test("renders embedded asset files", async () => {
    const root = await makeTempDirectory();
    const destination = join(root, "output");
    const embedded = new File(
      ["Hello {{projectName}}"],
      "agentcore-assets/src/assets/cdk/README.md",
    );

    await new AssetManager([embedded]).render("cdk", destination, {
      projectName: "embedded",
    });

    expect(await Bun.file(join(destination, "README.md")).text()).toBe("Hello embedded");
  });

  test("does not HTML-escape code template values", async () => {
    const root = await makeTempDirectory();
    const source = join(root, "assets", "cdk");
    const destination = join(root, "output");

    await mkdir(source, { recursive: true });
    await Bun.write(join(source, "config.ts"), "export const expr = {{expr}};");

    await new AssetManager([], join(root, "assets")).render("cdk", destination, {
      expr: "a && b < c",
    });

    expect(await Bun.file(join(destination, "config.ts")).text()).toBe(
      "export const expr = a && b < c;",
    );
  });

  test("rejects an embedded path that escapes the destination", async () => {
    const root = await makeTempDirectory();
    const destination = join(root, "output");
    const embedded = new File(
      ["pwned"],
      "agentcore-assets/src/assets/cdk/../../../../../../etc/evil",
    );

    await expect(new AssetManager([embedded]).render("cdk", destination)).rejects.toThrow(
      "Unsafe asset path",
    );
  });

  describe("resolveSourceRoot", () => {
    test("returns the bundled root when assets/ sits beside the module", async () => {
      const moduleDir = await makeTempDirectory();
      await mkdir(join(moduleDir, "assets"), { recursive: true });

      expect(resolveSourceRoot(moduleDir)).toBe(resolve(moduleDir, "assets"));
    });

    test("falls back to ../assets when no sibling assets/ exists", async () => {
      const moduleDir = await makeTempDirectory();

      expect(resolveSourceRoot(moduleDir)).toBe(resolve(moduleDir, "../assets"));
    });
  });

  test("cdk renders the expected output tree", async () => {
    // Real cdk asset, source-tree mode (no injected root, no embedded files).
    // Snapshots the rendered manifest so adding/removing/renaming an asset file
    // is a reviewable diff. Content is covered by the byte-for-byte tests above.
    const destination = await makeTempDirectory();
    await new AssetManager().render("cdk", destination);

    const rendered = (await readdir(destination, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(destination, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
      )
      .sort();

    expect(rendered).toMatchSnapshot();
  });

  test("rejects a missing asset", async () => {
    const root = await makeTempDirectory();

    await expect(
      new AssetManager([], join(root, "assets")).render("cdk", join(root, "output")),
    ).rejects.toThrow("Asset 'cdk' does not exist");
  });
});
