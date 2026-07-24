import Handlebars from "handlebars";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../fs";
import type { AssetFile, AssetName, AssetVariables, EmbeddedFile } from "./types";

// Bundled builds place `assets/` beside the module; source layout has it one up.
export function resolveSourceRoot(
  moduleDirectory = dirname(fileURLToPath(import.meta.url)),
): string {
  const bundledRoot = resolve(moduleDirectory, "assets");
  if (existsSync(bundledRoot)) {
    return bundledRoot;
  }

  return resolve(moduleDirectory, "../assets");
}

export class AssetManager {
  private handlebars = Handlebars.create();
  constructor(
    private readonly embeddedFiles: readonly EmbeddedFile[] = [],
    private readonly sourceRoot?: string,
  ) {}

  async render(
    asset: AssetName,
    destination: string,
    variables: AssetVariables = {},
  ): Promise<void> {
    const assetFiles =
      this.embeddedFiles.length > 0
        ? this.listEmbeddedFiles(asset)
        : await this.listFileSystemFiles(asset);

    if (assetFiles.length === 0) {
      throw new Error(`Asset '${asset}' does not exist`);
    }

    const resolvedDestination = resolve(destination);
    for (const file of assetFiles) {
      const outputPath = this.resolveOutputPath(resolvedDestination, file.relativePath);
      const rendered = this.handlebars.compile(await file.text(), {
        noEscape: true,
        strict: true,
      })(variables);

      await mkdir(dirname(outputPath), { recursive: true });
      await atomicWrite(outputPath, rendered);
    }
  }

  private async listFileSystemFiles(asset: AssetName): Promise<AssetFile[]> {
    const assetRoot = join(this.sourceRoot ?? resolveSourceRoot(), asset);

    let entries;
    try {
      entries = await readdir(assetRoot, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(assetRoot, join(entry.parentPath, entry.name)))
      .sort()
      .map((relativePath) => ({
        relativePath,
        text: () => readFile(join(assetRoot, relativePath), "utf8"),
      }));
  }

  private listEmbeddedFiles(asset: AssetName): AssetFile[] {
    const prefix = `agentcore-assets/src/assets/${asset}/`;

    return this.embeddedFiles
      .filter((file) => file.name.startsWith(prefix))
      .map((file) => ({
        relativePath: file.name.slice(prefix.length),
        text: () => file.text(),
      }))
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  }

  private resolveOutputPath(resolvedDestination: string, relativePath: string): string {
    const mapped = this.resolveTemplateName(relativePath).replaceAll("\\", "/");
    const segments = mapped.split("/");

    if (mapped.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`Unsafe asset path '${relativePath}'`);
    }

    const outputPath = resolve(resolvedDestination, mapped);
    if (outputPath !== resolvedDestination && !outputPath.startsWith(resolvedDestination + sep)) {
      throw new Error(`Asset path '${relativePath}' escapes destination`);
    }

    return outputPath;
  }

  private resolveTemplateName(relativePath: string): string {
    const filename = basename(relativePath);
    const ignore = filename.match(/^(git|npm)ignore\.template$/);
    return join(dirname(relativePath), ignore ? `.${ignore[1]}ignore` : filename);
  }
}
