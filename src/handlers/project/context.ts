import { contextKey } from "../../router";

// ProjectDetectedKey records whether the TUI was launched from inside a project
// without pinning a Project object that could become stale while the TUI is open.
export const ProjectDetectedKey = contextKey<boolean>("project.detected");

// V0ProjectDetectedKey lets every TUI screen show the compatibility notice
// without loading or retaining a mutable Project object for the whole session.
export const V0ProjectDetectedKey = contextKey<boolean>("project.v0.detected");

export interface V0ProjectNoticeState {
  enteredTui: boolean;
}

// The root command middleware uses this mutable invocation-local marker to
// avoid printing both a direct-command reminder and the TUI exit reminder.
export const V0ProjectNoticeStateKey = contextKey<V0ProjectNoticeState>("project.v0.noticeState");
