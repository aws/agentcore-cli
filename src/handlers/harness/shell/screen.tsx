import { useLocation, useNavigate, useParams } from "react-router";
import { HarnessEndpointPicker } from "../../../components/HarnessEndpointPicker";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { ShellHandoff } from "../../../components/ShellHandoff";
import { TuiExitErrorKey } from "../../../tui/exitError";
import type { ScreenProps } from "../../types";
import { HarnessShellLaunchContextKey } from "./launchContext";
import { runHarnessShell } from "./operation";

const shellPath = (...parts: string[]) =>
  ["/agentcore/harness/shell", ...parts.map(encodeURIComponent)].join("/");

type ShellLocationState = { returnOnEscape?: boolean; returnPath?: string };

export function HarnessShellScreen(props: ScreenProps) {
  const { harnessId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as ShellLocationState | null;
  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "shell"]}
        description="choose a harness to open a shell"
        onSelect={(id) =>
          navigate(shellPath(id), { state: { returnPath: state?.returnPath ?? location.pathname } })
        }
      />
    );
  }
  if (!qualifier) {
    const returnPath =
      state?.returnPath ??
      (state?.returnOnEscape
        ? `/agentcore/harness/get/${encodeURIComponent(harnessId)}`
        : location.pathname);
    return (
      <HarnessEndpointPicker
        {...props}
        harnessId={harnessId}
        breadcrumb={["agentcore", "harness", "shell", harnessId]}
        description="choose an endpoint to open a shell"
        onSelect={(selected) =>
          navigate(shellPath(harnessId, selected), {
            replace: state?.returnOnEscape === true,
            state: { ...state, returnPath },
          })
        }
        onEscape={() => (state?.returnOnEscape ? navigate(-1) : navigate(shellPath()))}
      />
    );
  }
  const launch = props.ctx.value(HarnessShellLaunchContextKey);
  return (
    <ShellHandoff
      label={`Opening shell for ${harnessId} (${qualifier})...`}
      returnPath={state?.returnPath}
      setExitError={props.ctx.value(TuiExitErrorKey)}
      run={(io) =>
        runHarnessShell({
          ...props,
          io,
          harnessId,
          qualifier,
          launchContext: launch?.harnessId === harnessId ? launch : undefined,
        })
      }
    />
  );
}
