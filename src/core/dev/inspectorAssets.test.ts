import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetSource } from "../project/source";
import { InspectorAssets } from "./inspectorAssets";

function fakeSource(files: Record<string, string>): AssetSource {
  return {
    read: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    },
    list: async () => Object.keys(files),
  };
}

let overrideDir: string;

beforeEach(async () => {
  overrideDir = await mkdtemp(join(tmpdir(), "inspector-assets-"));
});

afterEach(async () => {
  await rm(overrideDir, { recursive: true, force: true });
});

describe("InspectorAssets", () => {
  test("serves staged assets with MIME by extension", async () => {
    const assets = new InspectorAssets({
      source: fakeSource({
        "agent-inspector/index.html": "<html></html>",
        "agent-inspector/index.js": "app()",
        "agent-inspector/favicon.svg": "<svg/>",
      }),
      overrideDir: "",
    });

    const html = await assets.read("/index.html");
    expect(new TextDecoder().decode(html!.body)).toBe("<html></html>");
    expect(html!.contentType).toBe("text/html; charset=utf-8");
    expect((await assets.read("index.js"))!.contentType).toBe("text/javascript; charset=utf-8");
    expect((await assets.read("favicon.svg"))!.contentType).toBe("image/svg+xml");
  });

  test("falls back to the packaged dist-assets when nothing is staged", async () => {
    const assets = new InspectorAssets({ source: fakeSource({}), overrideDir: "" });
    const html = await assets.read("index.html");
    // @aws/agent-inspector is a real dependency of this repo, so the fallback resolves.
    expect(html).toBeDefined();
    expect(html!.contentType).toBe("text/html; charset=utf-8");
  });

  test("AGENT_INSPECTOR_PATH overrides everything for SPA development", async () => {
    await writeFile(join(overrideDir, "index.html"), "local dev build");
    const assets = new InspectorAssets({ source: fakeSource({}), overrideDir });

    const html = await assets.read("index.html");
    expect(new TextDecoder().decode(html!.body)).toBe("local dev build");
    expect(await assets.read("missing.js")).toBeUndefined();
  });

  test("rejects path traversal and empty paths", async () => {
    const assets = new InspectorAssets({
      source: fakeSource({ "agent-inspector/index.html": "x" }),
      overrideDir: "",
    });
    expect(await assets.read("../secrets.txt")).toBeUndefined();
    expect(await assets.read("a/../../b")).toBeUndefined();
    expect(await assets.read("/")).toBeUndefined();
  });
});
