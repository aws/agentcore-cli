import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, createHandler, ProjectKey } from "../router";
import type { Project } from "../handlers/project/types";
import { createSilentLogger } from "../testing";
import { withProject } from "./withProject";
import { FsProjectManager } from "../core/project";

function app(cwd: string, onProject?: (project: Project | undefined) => void): Router {
  const projectManager = new FsProjectManager({ logger: createSilentLogger() });
  const router = new Router("app", "test");
  router.use(withProject({ projectManager, cwd }));
  router.handler(
    createHandler({
      name: "check",
      description: "noop",
      handle: async (ctx) => {
        onProject?.(ctx.value(ProjectKey));
      },
    }),
  );
  return router;
}

describe("withProject", () => {
  test("throws when no project encloses the working directory", async () => {
    await expect(app("/some/path").route(["node", "app", "check"])).rejects.toThrow(
      /Unable to find project/,
    );
  });

  test("pins the resolved project on the context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-withproject-"));
    try {
      await mkdir(join(directory, "agentcore"), { recursive: true });
      await writeFile(
        join(directory, "agentcore", "agentcore.json"),
        JSON.stringify({ name: "example" }),
      );

      let seen: Project | undefined;
      await app(directory, (project) => (seen = project)).route(["node", "app", "check"]);
      expect(seen).toEqual({ name: "example", root: directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
