import { useEffect, useRef } from "react";
import { useApp, useStderr, useStdin, useStdout } from "ink";
import { useLocation, useNavigate, useParams } from "react-router";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { Spinner } from "../../../components/ui/spinner";
import { SilentCLIError } from "../../../errors";
import type { ScreenProps } from "../../types";
import { RuntimeShellLaunchContextKey } from "./launchContext";
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

  return (
    <RuntimeShellHandoff
      {...props}
      runtimeId={runtimeId}
      qualifier={qualifier}
      returnPath={locationState?.returnPath}
    />
  );
}

function RuntimeShellHandoff({
  ctx,
  core,
  runtimeId,
  qualifier,
  returnPath,
}: ScreenProps & { runtimeId: string; qualifier: string; returnPath?: string }) {
  const { exit, suspendTerminal } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { stderr } = useStderr();
  const navigate = useNavigate();
  const requested = useRef(false);
  const launchContext = ctx.value(RuntimeShellLaunchContextKey);
  const initialContext = launchContext?.runtimeId === runtimeId ? launchContext : undefined;

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        await suspendTerminal(() =>
          runRuntimeShell({
            ctx,
            core,
            io: { stdin, stdout, stderr },
            runtimeId,
            qualifier,
            launchContext: initialContext,
          }),
        );
      } catch (error) {
        if (returnPath === undefined || !(error instanceof SilentCLIError)) {
          exit(error);
          return;
        }
      }
      if (returnPath === undefined) {
        exit();
      } else {
        navigate(returnPath, { replace: true });
      }
    })();
  }, [
    core,
    ctx,
    exit,
    initialContext,
    navigate,
    qualifier,
    returnPath,
    runtimeId,
    stderr,
    stdin,
    stdout,
    suspendTerminal,
  ]);

  return <Spinner label={`Opening shell for ${runtimeId} (${qualifier})...`} />;
}
