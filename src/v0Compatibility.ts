import { enclosingProjectRoot, isV0Project } from "./core/project/fsUtils";
import { ProjectStateError } from "./errors";
import { runInheritedProcess, type InheritedProcessRunner } from "./io";

export const V0_CLI_VERSION = "0.31.1";
export const V0_CLI_PACKAGE = `@aws/agentcore@${V0_CLI_VERSION}`;

const DELEGATED_COMMANDS = new Set([
  "d",
  "deploy",
  "dev",
  "dp",
  "i",
  "invoke",
  "l",
  "logs",
  "s",
  "status",
  "t",
  "traces",
]);
const BLOCKED_COMMANDS = new Set(["build", "export"]);

export type V0CompatibilityOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
  runner?: InheritedProcessRunner;
  writeStatus?: (message: string) => void;
};

type CompatibilityAction =
  { type: "delegate" } | { type: "block"; command: string } | { type: "v1" };

function compatibilityAction(args: string[]): CompatibilityAction {
  if (args.length === 0) return { type: "delegate" };

  const command = args[0]!;
  if (DELEGATED_COMMANDS.has(command)) return { type: "delegate" };
  if (BLOCKED_COMMANDS.has(command)) return { type: "block", command };
  return { type: "v1" };
}

function blockedMessage(command: string): string {
  const reason =
    command === "build"
      ? "The v0 CLI did not expose build as a standalone command."
      : "Export is not supported while the project remains in the v0 format.";
  return (
    `This project uses the v0 format (agentcore.json version 1). ${reason} ` +
    `Run \`agentcore migrate\` to use the v1 ${command} command.`
  );
}

/**
 * Hands project workflows back to the final v0 CLI before v1 parses their
 * arguments. Returns undefined when normal v1 routing should continue.
 */
export async function runV0Compatibility(
  argv: string[],
  options: V0CompatibilityOptions = {},
): Promise<number | undefined> {
  const args = argv.slice(2);
  const action = compatibilityAction(args);
  if (action.type === "v1") return undefined;

  const cwd = options.cwd ?? process.cwd();
  const projectRoot = enclosingProjectRoot(cwd);
  if (!projectRoot || !(await isV0Project(projectRoot))) return undefined;

  if (action.type === "block") throw new ProjectStateError(blockedMessage(action.command));

  const isInteractive = options.isInteractive ?? process.stderr.isTTY === true;
  if (isInteractive && !args.includes("--json")) {
    const writeStatus = options.writeStatus ?? ((message) => process.stderr.write(message));
    writeStatus(
      `This is a v0 project; running AgentCore CLI ${V0_CLI_VERSION} in compatibility mode. ` +
        "Run `agentcore migrate` to upgrade it to v1.\n",
    );
  }

  const env = {
    ...(options.env ?? process.env),
    AGENTCORE_SKIP_CONFLICT_CHECK: "1",
  };
  const runner = options.runner ?? runInheritedProcess;
  return runner(["npx", "--yes", V0_CLI_PACKAGE, ...args], {
    cwd: projectRoot,
    env,
  });
}
