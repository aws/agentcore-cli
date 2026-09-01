import { test, expect, describe } from "bun:test";
import { Router, createHandler } from "../router";
import { createSilentLogger, TestIdentityClient } from "../testing";
import { withProject } from "./withProject";
import { FsProjectManager } from "../core/project";

describe("withProject", () => {
  test("throws when no project encloses the cwd", async () => {
    const projectManager = new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
    });

    const app = new Router("app", "test");
    app.use(withProject({ projectManager, cwd: "/some/path" }));
    app.handler(
      createHandler({
        name: "check",
        description: "noop",
        handle: async () => {},
      }),
    );

    await expect(app.route(["node", "app", "check"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("defaults to the cwd at invocation time when none is configured", async () => {
    const projectManager = new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
    });

    const app = new Router("app", "test");
    app.use(withProject({ projectManager }));
    app.handler(createHandler({ name: "check", description: "noop", handle: async () => {} }));

    // tmpdir encloses no project, so the message must name the cwd it searched.
    await expect(app.route(["node", "app", "check"])).rejects.toThrow(process.cwd());
  });
});
