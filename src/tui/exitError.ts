import { contextKey } from "../router";

export type SetTuiExitError = (error: Error | undefined) => void;

export const TuiExitErrorKey = contextKey<SetTuiExitError>("tui.exitError");
