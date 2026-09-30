import { render } from "ink";
import { QueryClient } from "@tanstack/react-query";
import { Root } from "../components/Root";
import {
  type Context,
  type DefaultHandle,
  PathKey,
  CommandKey,
  contextKey,
  type ContextKey,
  CommandRunMetricEventKey,
  ProjectKey,
} from "../router";
import type { AppIO } from "../io";
import type { Core } from "../handlers/types";
import { JsonKey } from "../handlers/keys";
import { ProjectDetectedKey } from "../handlers/project/context";
import { ExitCode, InvalidEnvironmentError } from "../errors";
import { TuiExitMessageKey } from "./exitMessage";
import { createResizeGate } from "./resize";
import { TuiHandoffKey, handoffArgs } from "./handoff";

// renderJson pretty-prints a value as indented JSON. It is the output
// counterpart to renderTui: handlers call it to emit machine-readable results
// (e.g. when --json is set) rather than rendering the interactive TUI. The
// destination is injectable (`writer`, default console.log) so output can be
// redirected — most importantly captured in tests.
export function renderJson(data: unknown, writer: (line: string) => void = console.log): void {
  writer(JSON.stringify(data, null, 2));
}

// JsonRenderer is the JSON output capability handlers consume from the context.
// Wiring it through the context (rather than importing renderJson directly) lets
// the app inject a renderer bound to the configured stdout, keeping handlers free
// of any direct dependency on a global output stream.
export interface JsonRenderer {
  renderJson(data: unknown): void;
  renderJsonLine(data: unknown): void;
}

// JsonRendererKey exposes the prewired JsonRenderer on the context. Installed by
// the withJsonRenderer middleware at the root; read by any leaf that emits JSON.
export const JsonRendererKey: ContextKey<JsonRenderer> = contextKey<JsonRenderer>("json.renderer");

function isRootMenuPath(path: string): boolean {
  const pathname = new URL(path, "http://localhost").pathname.replace(/\/+$/, "");
  return pathname === "/agentcore";
}

// renderTuiAt mounts the Ink React tree at an explicit route path and resolves
// once the app exits. Handlers use it to deep-link into a TUI screen (e.g.
// `invoke --id X --session-id Y` opens the chat at that harness and session).
export async function renderTuiAt(
  path: string,
  ctx: Context,
  core: Core,
  io: AppIO,
): Promise<void> {
  ctx.value(CommandRunMetricEventKey)?.setAttributes({ is_tui: true });

  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new InvalidEnvironmentError("interactive mode requires a TTY on stdin and stdout", {
      exitCode: ExitCode.USAGE,
    });
  }

  let exitMessage: string | undefined;
  let handoff: string[] | undefined;
  let tuiContext = ctx;
  if (isRootMenuPath(path)) {
    const projectDetected =
      ctx.value(ProjectKey) !== undefined ||
      (await core.projectManager.resolve({
        filePath: process.cwd(),
      })) !== undefined;
    tuiContext = tuiContext.withValue(ProjectDetectedKey, projectDetected);
  }
  tuiContext = tuiContext
    .withValue(TuiExitMessageKey, (message) => {
      exitMessage = message;
    })
    .withValue(TuiHandoffKey, (commandPath) => {
      handoff = commandPath;
    });

  // alternateScreen switches the terminal to its alternate buffer so the TUI
  // takes over the screen and the prior scrollback is restored on exit (like Vim).
  const queryClient = new QueryClient();

  const resizeGate = createResizeGate(io.stdout);
  const { waitUntilExit } = render(
    <Root path={path} ctx={tuiContext} core={core} queryClient={queryClient} />,
    {
      stdin: io.stdin,
      stdout: resizeGate.stdout,
      stderr: io.stderr,
      interactive: true,
      alternateScreen: true,
      incrementalRendering: false,
    },
  );
  try {
    await waitUntilExit();
  } finally {
    resizeGate.dispose();
  }
  if (exitMessage !== undefined) {
    io.stdout.write(exitMessage.endsWith("\n") ? exitMessage : `${exitMessage}\n`);
  }
  if (handoff !== undefined) {
    // Re-dispatch through the same Commander tree so the command runs with its
    // full middleware stack, exactly as `agentcore <command>` would.
    let root = ctx.require(CommandKey);
    while (root.parent) root = root.parent;
    await root.parseAsync(handoffArgs(root, handoff), { from: "user" });
  }
}

// renderTui builds the root DefaultHandle that mounts the Ink React tree. It
// reads the command path from the context and passes it, along with the injected
// `core` clients, into the Root component. Ink reads/writes through the injected
// io streams so the TUI is testable and decoupled from the process streams. The
// handler resolves once the Ink app exits. If JSON mode is enabled, it prints
// help text to the configured stdout and returns.
export function renderTui(core: Core, io: AppIO): DefaultHandle {
  return async (ctx) => {
    if (ctx.require(JsonKey)) {
      const c = ctx.require(CommandKey);
      io.stdout.write(c.helpInformation());
      return;
    }

    await renderTuiAt(ctx.require(PathKey), ctx, core, io);
  };
}
