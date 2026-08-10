import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

// The read-only TUI offers only get/list. The mutating subcommands stay CLI-only
// for now, so they are omitted from the menu — an unrouted menu entry would fall
// through to the HelpScreen catch-all and exit the app.
const OMIT = ["create", "update", "pause", "resume", "delete"];

export function OnlineEvalScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "online-eval"]} omit={OMIT} />;
}
