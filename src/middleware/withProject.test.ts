import { test, expect, describe } from "bun:test";
import { NoProjectError } from "../errors";
import type { Project, ProjectManager } from "../handlers/project/types";
import { ProjectKey, Router, createHandler } from "../router";
import { withProject } from "./withProject";

function app(projectManager: ProjectManager, onProject: (project: Project | undefined) => void) {
  const router = new Router("app", "test");
  router.use(withProject({ projectManager, cwd: "/some/path" }));
  router.handler(
    createHandler({
      name: "check",
      description: "noop",
      handle: async (ctx) => onProject(ctx.value(ProjectKey)),
    }),
  );
  return router;
}

describe("withProject", () => {
  test("pins the resolved project on the context", async () => {
    const project: Project = { name: "example", rootPath: "/some/path", runtimes: [] };
    const projectManager = {
      resolve: async () => project,
      create: async () => project,
    };

    let seen: Project | undefined;
    await app(projectManager, (p) => (seen = p)).route(["node", "app", "check"]);
    expect(seen).toEqual(project);
  });

  test("throws NoProjectError when no project encloses the working directory", async () => {
    const projectManager = {
      resolve: async () => undefined,
      create: async () => ({}) as Project,
    };

    await expect(
      app(projectManager, () => {}).route(["node", "app", "check"]),
    ).rejects.toBeInstanceOf(NoProjectError);
  });
});
