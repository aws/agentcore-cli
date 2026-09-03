import { useEffect, useRef } from "react";
import { useApp } from "ink";
import { useLocation, useNavigate, useParams } from "react-router";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { Spinner } from "../../../components/ui/spinner";
import { TuiHandoffKey } from "../../../tui/handoff";
import type { ScreenProps } from "../../types";
import { RuntimeShellLaunchContextKey } from "./launchContext";
import { runRuntimeShell } from "./operation";

type RuntimeShellLocationState = {
  returnOnEscape?: boolean;
};

const shellPath = (...parts: string[]) =>
  ["/agentcore/runtime/shell", ...parts.map(encodeURIComponent)].join("/");

export function RuntimeShellScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const returnOnEscape = (location.state as RuntimeShellLocationState | null)?.returnOnEscape;

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "shell"]}
        description="choose a Runtime to open a shell"
        onSelect={(id) => navigate(shellPath(id))}
      />
    );
  }
  if (!qualifier) {
    return (
      <RuntimeEndpointPicker
        {...props}
        runtimeId={runtimeId}
        breadcrumb={["agentcore", "runtime", "shell", runtimeId]}
        description="choose an endpoint to open a shell"
        onSelect={(selected) =>
          navigate(shellPath(runtimeId, selected), {
            replace: returnOnEscape === true,
            state: returnOnEscape ? { returnOnEscape } : undefined,
          })
        }
        onEscape={() => (returnOnEscape ? navigate(-1) : navigate(shellPath()))}
      />
    );
  }

  return <RuntimeShellHandoff {...props} runtimeId={runtimeId} qualifier={qualifier} />;
}

function RuntimeShellHandoff({
  ctx,
  core,
  runtimeId,
  qualifier,
}: ScreenProps & { runtimeId: string; qualifier: string }) {
  const { exit } = useApp();
  const requested = useRef(false);
  const launchContext = ctx.value(RuntimeShellLaunchContextKey);
  const initialContext = launchContext?.runtimeId === runtimeId ? launchContext : undefined;

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    ctx.require(TuiHandoffKey).request(({ ctx, core, io }) =>
      runRuntimeShell({
        ctx,
        core,
        io,
        runtimeId,
        qualifier,
        launchContext: initialContext,
      }),
    );
    exit();
  }, [ctx, core, exit, initialContext, qualifier, runtimeId]);

  return <Spinner label={`Opening shell for ${runtimeId} (${qualifier})...`} />;
}
