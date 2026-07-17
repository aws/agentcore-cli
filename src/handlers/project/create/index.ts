import z from "zod";
import { createHandler, flag } from "../../../router";

export const PROJECT_TEMPLATES = ["placeholder"] as const;

export const createCreateProjectHandler = () =>
  createHandler({
    name: "create",
    description: "create a new AgentCore project",
    flags: [
      flag(
        "template",
        "project template to scaffold from",
        z.enum(PROJECT_TEMPLATES).default("placeholder"),
      ),
    ],
    handle: async () => {
      throw new Error("`agentcore project create` is not implemented yet");
    },
  });
