import { useParams, useSearchParams } from "react-router";
import type { ScreenProps } from "../../types";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { HarnessChat } from "../invoke/screen";
import { useRegionNavigate } from "../../utils";

// HarnessExecScreen is `harness exec` in the TUI: the same chat screen as
// invoke, but starting in exec mode ($ prompt, enter runs a shell command in
// the session's container). Ctrl+E flips between exec and chat at any time.
// Without a `:harnessId` route value it renders the harness picker. A
// `:sessionId` route value resumes that runtime session.
export function HarnessExecScreen(props: ScreenProps) {
  const { harnessId, sessionId } = useParams();
  const [search] = useSearchParams();
  const navigate = useRegionNavigate();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "exec"]}
        description="choose a harness to exec into"
        onSelect={(id) => navigate(`/agentcore/harness/exec/${id}`)}
      />
    );
  }
  return (
    <HarnessChat
      {...props}
      harnessId={harnessId}
      initialSessionId={sessionId}
      initialQualifier={search.get("qualifier") ?? undefined}
      variant="exec"
    />
  );
}
