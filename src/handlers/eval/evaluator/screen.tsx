import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

// The read-only TUI offers only get/list. The mutating subcommands
// (llm-as-a-judge and code-based, which host create/update; and delete) stay
// CLI-only for now, so they are omitted from the menu — an unrouted menu entry
// would fall through to the HelpScreen catch-all and exit the app.
const OMIT = ["llm-as-a-judge", "code-based", "delete"];

export function EvaluatorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "evaluator"]} omit={OMIT} />;
}
