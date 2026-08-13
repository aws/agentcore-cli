import z from "zod";
import { createHandler, flag } from "../../../router";
import type { AppIO } from "../../../io";
import { PROJECT_TEMPLATES, type ProjectManager } from "../types";
import { ProjectNameSchema } from "../../../projectSchemas/project";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createCreateProjectHandler = (config: CreateProjectHandlerConfig) =>
  createHandler({
    name: "create",
    description: "create a new AgentCore project",
    flags: [
      flag("name", "name of the project to create", ProjectNameSchema),
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
      for await (const event of config.projectManager.create({
        name: flags["name"],
        template: flags["template"],
        skipInstall: flags["skip-install"],
        skipGit: flags["skip-git"],
      })) {
        if (event.message) {
          config.io.stderr.write(`${event.message}\n`);
        }
      }

      config.io.stderr.write(`Created project '${flags["name"]}' in ./${flags["name"]}\n`);
    },
  });
