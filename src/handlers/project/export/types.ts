import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import type { ProjectManager } from "../types";

/** Dependencies for `project export` handlers. */
export type ExportProjectResourceConfig = {
  projectManager: ProjectManager;
  /** Service clients, for exporting a harness fetched by ARN. */
  core: Core;
  io: AppIO;
};
