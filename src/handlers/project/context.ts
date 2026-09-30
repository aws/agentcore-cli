import { contextKey } from "../../router";

// ProjectDetectedKey records whether the TUI was launched from inside a project
// without pinning a Project object that could become stale while the TUI is open.
export const ProjectDetectedKey = contextKey<boolean>("project.detected");
