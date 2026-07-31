import z from "zod";
import { createHandler, flag } from "../../../router";
import type { AppIO } from "../../../io";
import { PROJECT_TEMPLATES, ProjectNameSchema, type ProjectManager } from "../types";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createCreateProjectHandler = (config: CreateProjectHandlerConfig) =>
  createHandler({
    name: "create",
    description: "create a new AgentCore project",
    flags: [
      flag("project-name", "name of the project to create", ProjectNameSchema),
      flag(
        "template",
        "project template to scaffold from",
        z.enum(PROJECT_TEMPLATES).default(PROJECT_TEMPLATES.HELLO_WORLD_PYTHON),
      ),
      flag(
        "skip-install",
        "skip installing dependencies (npm install, uv sync)",
        z.boolean().default(false),
      ),
      flag("skip-git", "skip initializing a git repository", z.boolean().default(false)),
    ],
    handle: async (_ctx, flags) => {
      // Progress and success go to stderr, keeping stdout for machine output.
      const project = await config.projectManager.create({
        name: flags["project-name"],
        template: flags["template"],
        skipInstall: flags["skip-install"],
        skipGit: flags["skip-git"],
        onProgress: (event) => config.io.stderr.write(`${event.message}\n`),
      });
      config.io.stderr.write(`Created project '${project.name}' in ./${project.name}\n`);
    },
  });
