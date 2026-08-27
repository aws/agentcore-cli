import type { AppIO } from "../../../io";
import type { ProjectManager } from "../types";
import type { CorePolicyClient } from "./policy/types";

export type AddProjectResourceConfig = {
  projectManager: ProjectManager;
  policy: CorePolicyClient;
  io: AppIO;
};
