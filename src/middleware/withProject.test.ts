import { test, expect, describe } from "bun:test";
import { Router, createHandler } from "../router";
import { createSilentLogger } from "../testing";
import { withProject } from "./withProject";
import { FsProjectManager } from "../core/project";

describe("withProject", () => {
  test("throws when no project can be resolved", async () => {
    const projectManager = new FsProjectManager({ logger: createSilentLogger() });

    const app = new Router("app", "test");
    app.use(withProject({ projectManager, cwd: "/some/path" }));
    app.handler(
      createHandler({
        name: "check",
        description: "noop",
        handle: async () => {},
      }),
    );

    await expect(app.route(["node", "app", "check"])).rejects.toThrow(
      "Unable to find project at path /some/path",
    );
  });
});
