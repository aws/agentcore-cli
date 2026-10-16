import z from "zod";
import { ExitCode, InvalidEnvironmentError, SilentCLIError } from "../errors";
import { InteractiveTerminal, type AppIO } from "../io";
import type { RuntimeShellSession } from "./runtime/types";

export const shellIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "invalid shell ID");

export type ShellResumeTarget = {
  resource: "runtime" | "harness";
  id: string;
  qualifier: string;
  region: string;
  requiresBearerToken: boolean;
};

export class ShellOperation {
  constructor(private readonly io: AppIO) {}

  requireTerminal(): void {
    if (!this.io.stdin.isTTY || !this.io.stdout.isTTY) {
      throw new InvalidEnvironmentError("interactive mode requires a TTY on stdin and stdout", {
        exitCode: ExitCode.USAGE,
      });
    }
  }

  readonly onReconnect = (reconnected: boolean): void => {
    this.io.stderr.write(
      reconnected
        ? "\r\nReattached to existing shell.\r\n"
        : "\r\nPrevious shell unavailable; started a new shell.\r\n",
    );
  };

  async run(session: RuntimeShellSession, target: ShellResumeTarget): Promise<void> {
    this.io.stderr.write(
      `Connected - session ${session.runtimeSessionId} - shell ${session.shellId} - Ctrl+D or 'exit' to quit\n`,
    );
    this.io.stderr.write(
      `To reconnect: agentcore ${target.resource} shell --id ${target.id} --qualifier ${target.qualifier} --session-id ${session.runtimeSessionId} --shell-id ${session.shellId} --region ${target.region}\n`,
    );
    if (target.requiresBearerToken) {
      this.io.stderr.write("Provide --bearer-token again when reconnecting.\n");
    }
    try {
      await new InteractiveTerminal({ io: this.io }).run(session);
    } finally {
      await session.close();
    }
    if (session.kicked) {
      this.io.stderr.write("\nShell attached from another client.\n");
      throw new SilentCLIError("shell attached from another client");
    }
    if (session.exitCode === null) {
      this.io.stderr.write("\nShell connection ended without an exit code.\n");
      throw new SilentCLIError("shell connection ended without an exit code");
    }
    this.io.stderr.write(`\nSession closed \u00b7 exit ${session.exitCode}\n`);
    if (session.exitCode !== 0) {
      throw new SilentCLIError(`shell exited with code ${session.exitCode}`, {
        exitCode: session.exitCode,
      });
    }
  }
}
