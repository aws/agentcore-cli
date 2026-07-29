import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createDeployProjectHandler = () =>
  createHandler({
    name: "deploy",
    description: "deploy the project to AWS",
    handle: async () => {
      throw new NotImplementedError("agentcore project deploy is not implemented yet");
    },
  });
