import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createBuildProjectHandler = () =>
  createHandler({
    name: "build",
    description: "build the project's deployable artifacts",
    handle: async () => {
      throw new NotImplementedError("agentcore project build is not implemented yet");
    },
  });
