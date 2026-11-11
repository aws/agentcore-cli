import { useLocation, useNavigate, useParams } from "react-router";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { ShellHandoff } from "../../../components/ShellHandoff";
import { TuiExitErrorKey } from "../../../tui/exitError";
import type { ScreenProps } from "../../types";
import { RuntimeShellLaunchContextKey } from "./launchContext";
import { runtimeShellErrorHint } from "./error";
import { runRuntimeShell } from "./operation";

type RuntimeShellLocationState = {
  returnOnEscape?: boolean;
  returnPath?: string;
};

const shellPath = (...parts: string[]) =>
  ["/agentcore/runtime/shell", ...parts.map(encodeURIComponent)].join("/");

export function RuntimeShellScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const locationState = location.state as RuntimeShellLocationState | null;
  const returnOnEscape = locationState?.returnOnEscape;

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "shell"]}
        description="choose a Runtime to open a shell"
        onSelect={(id) =>
          navigate(shellPath(id), {
            state: { returnPath: locationState?.returnPath ?? location.pathname },
          })
        }
      />
    );
  }
  if (!qualifier) {
    const returnPath =
      locationState?.returnPath ??
      (returnOnEscape
        ? `/agentcore/runtime/get/${encodeURIComponent(runtimeId)}`
        : location.pathname);
    return (
      <RuntimeEndpointPicker
        {...props}
        runtimeId={runtimeId}
        breadcrumb={["agentcore", "runtime", "shell", runtimeId]}
        description="choose an endpoint to open a shell"
        onSelect={(selected) =>
          navigate(shellPath(runtimeId, selected), {
            replace: returnOnEscape === true,
            state: {
              ...locationState,
              returnPath,
            },
          })
        }
        onEscape={() => (returnOnEscape ? navigate(-1) : navigate(shellPath()))}
      />
    );
  }

  const launch = props.ctx.value(RuntimeShellLaunchContextKey);
  return (
    <ShellHandoff
      label={`Opening shell for ${runtimeId} (${qualifier})...`}
      returnPath={locationState?.returnPath}
      errorHint={runtimeShellErrorHint}
      setExitError={props.ctx.value(TuiExitErrorKey)}
      run={(io) =>
        runRuntimeShell({
          ...props,
          io,
          runtimeId,
          qualifier,
          launchContext: launch?.runtimeId === runtimeId ? launch : undefined,
        })
      }
    />
  );
}
