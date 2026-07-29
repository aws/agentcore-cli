import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createRemoveProjectHandler = () =>
  createHandler({
    name: "remove",
    description: "remove a resource from the project",
    handle: async () => {
      throw new NotImplementedError("agentcore project remove is not implemented yet");
    },
  });
