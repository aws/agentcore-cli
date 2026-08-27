import type { AppIO } from "../../../io";
import type { ProjectManager } from "../types";

export type AddProjectResourceConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};
