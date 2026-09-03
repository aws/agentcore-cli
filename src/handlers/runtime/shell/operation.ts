import { InputValidationError, InvalidEnvironmentError, SilentCLIError } from "../../../errors";
import { InteractiveTerminal, type AppIO } from "../../../io";
import type { Context } from "../../../router";
import { ExitCode } from "../../../runnable";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { RuntimeShellLaunchContext } from "./launchContext";
import { normalizeRuntimeShellRequest } from "./request";

export type RunRuntimeShellInput = {
  ctx: Context;
  core: Core;
  io: AppIO;
  runtimeId: string;
  qualifier: string;
  launchContext?: RuntimeShellLaunchContext;
};

export async function runRuntimeShell(input: RunRuntimeShellInput): Promise<void> {
  const { ctx, core, io, runtimeId, qualifier, launchContext } = input;
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new InvalidEnvironmentError("interactive mode requires a TTY on stdin and stdout", {
      exitCode: ExitCode.USAGE,
    });
  }

  const options = coreOptsFromCtx(ctx);
  if (options.endpointUrl !== undefined) {
    throw new InputValidationError("runtime shell does not support --endpoint-url");
  }
  const detail = await core.runtime.getRuntime(runtimeId, options);
  const request = normalizeRuntimeShellRequest(detail, {
    qualifier,
    runtimeSessionId: launchContext?.runtimeSessionId,
    bearerToken: launchContext?.bearerToken,
  });
  request.onReconnect = (reconnected) => {
    io.stderr.write(
      reconnected
        ? "\r\nReattached to existing shell.\r\n"
        : "\r\nPrevious shell unavailable; started a new shell.\r\n",
    );
  };

  io.stderr.write(`Connecting to Runtime ${runtimeId} (${qualifier})...\n`);
  const session = await core.runtime.openRuntimeShell(request, options);
  io.stderr.write(`Connected · session ${session.runtimeSessionId} · Ctrl+D or 'exit' to quit\n`);

  const terminal = new InteractiveTerminal({ io });
  try {
    await terminal.run(session);
  } finally {
    await session.close();
  }
  if (session.kicked) {
    io.stderr.write("\nShell attached from another client.\n");
    throw new SilentCLIError("shell attached from another client");
  }
  if (session.exitCode === null) {
    io.stderr.write("\nShell connection ended without an exit code.\n");
    throw new SilentCLIError("shell connection ended without an exit code");
  }

  io.stderr.write(`\nSession closed · exit ${session.exitCode}\n`);
  if (session.exitCode !== 0) {
    throw new SilentCLIError(`shell exited with code ${session.exitCode}`, {
      exitCode: session.exitCode,
    });
  }
}
