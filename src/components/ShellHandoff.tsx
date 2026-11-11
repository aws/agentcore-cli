import { useEffect, useRef, useState } from "react";
import { Text, useApp, useInput, useStderr, useStdin, useStdout } from "ink";
import { useLocation, useNavigate } from "react-router";
import { AgentCoreCLIError, SilentCLIError } from "../errors";
import type { AppIO } from "../io";
import type { SetTuiExitError } from "../tui/exitError";
import { Layout } from "./Layout";
import { Spinner } from "./ui/spinner";

type ShellHandoffProps = {
  label: string;
  returnPath?: string;
  run: (io: AppIO) => Promise<void>;
  errorHint?: (error: Error) => string | undefined;
  setExitError?: SetTuiExitError;
};

export function ShellHandoff({
  label,
  returnPath,
  run,
  errorHint,
  setExitError,
}: ShellHandoffProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { stderr } = useStderr();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") exit(error ?? undefined);
      else if (key.escape) {
        if (returnPath === undefined) exit(error ?? undefined);
        else {
          setExitError?.(undefined);
          navigate(returnPath, { replace: true });
        }
      } else if (input === "r") {
        requested.current = false;
        setExitError?.(undefined);
        setError(null);
        setAttempt((current) => current + 1);
      }
    },
    { isActive: error !== null },
  );

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        await suspendTerminal(() => run({ stdin, stdout, stderr }));
      } catch (caught) {
        if (!(caught instanceof SilentCLIError)) {
          const failure = AgentCoreCLIError.fromError(caught);
          setExitError?.(failure);
          setError(failure);
          return;
        }
        if (returnPath === undefined) {
          exit(caught);
          return;
        }
      }
      if (returnPath === undefined) exit();
      else navigate(returnPath, { replace: true });
    })();
  }, [
    attempt,
    exit,
    navigate,
    returnPath,
    run,
    setExitError,
    stderr,
    stdin,
    stdout,
    suspendTerminal,
  ]);

  if (error) {
    const hint = errorHint?.(error);
    return (
      <Layout
        breadcrumb={location.pathname.split("/").filter(Boolean).map(decodeURIComponent)}
        keyHints={[
          { key: "r", label: "retry" },
          { key: "esc", label: returnPath === undefined ? "quit" : "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        <Text color="red">Error: {error.message}</Text>
        {hint && (
          <Text>
            {"\n"}
            {hint}
          </Text>
        )}
      </Layout>
    );
  }
  return <Spinner label={label} />;
}
