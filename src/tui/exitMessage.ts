import { contextKey } from "../router";

export type SetTuiExitMessage = (message: string) => void;

// Screens can register guidance that should appear only after Ink restores the
// normal terminal buffer.
export const TuiExitMessageKey = contextKey<SetTuiExitMessage>("tui.exitMessage");
