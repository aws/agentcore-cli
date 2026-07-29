import { createHandler } from "../../../router";
import { NotImplementedError } from "../../../errors";

export const createDevProjectHandler = () =>
  createHandler({
    name: "dev",
    description: "run the project locally for development",
    handle: async () => {
      throw new NotImplementedError("agentcore project dev is not implemented yet");
    },
  });
