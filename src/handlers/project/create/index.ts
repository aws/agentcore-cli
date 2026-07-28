import z from "zod";
import { createHandler, flag } from "../../../router";
import { PROJECT_TEMPLATES, ProjectNameSchema, type ProjectManager } from "../types";

type CreateProjectHandlerConfig = {
  projectManager: ProjectManager;
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
    ],
    handle: async (_ctx, flags) => {
      await config.projectManager.create({
        name: flags["project-name"],
        template: flags["template"],
      });
    },
  });
