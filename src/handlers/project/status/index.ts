import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createStatusProjectHandler = () =>
  createHandler({
    name: "status",
    description: "show the status of the project's deployed resources",
    handle: async () => {
      throw new NotImplementedError("agentcore project status is not implemented yet");
    },
  });
