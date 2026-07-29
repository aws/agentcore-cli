import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createAddProjectHandler = () =>
  createHandler({
    name: "add",
    description: "add a resource to the project",
    handle: async () => {
      throw new NotImplementedError("agentcore project add is not implemented yet");
    },
  });
