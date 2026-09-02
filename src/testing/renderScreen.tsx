import { render, cleanup } from "ink-testing-library";
import { QueryClient } from "@tanstack/react-query";
import { ValueContext, compile, CommandKey, type Context } from "../router";
import { RegionKey, JsonKey, DebugKey, EndpointKey } from "../handlers/keys";
import { JsonRendererKey } from "../tui";
import { createRootHandler } from "../handlers";
import { Root } from "../components/Root";
import { TestCoreClient } from "./TestCoreClient";
import { testIO } from "./testIO";
import { tick, waitFor } from "./timing";
import { createSilentLogger } from "./logging";
import { TestGlobalConfigAccessor } from "./globalConfig";

// TUI test harness.
//
// Screens are mounted through the real Root (MemoryRouter + the app's route
// table + react-query), seeded at a given path — exactly how the CLI mounts
// them. So a single render exercises routing, params, data fetching, and the
// screen itself, and key presses can drive navigation between screens.
//
// ink-testing-library provides a fake TTY (isTTY=true, no-op setRawMode) and
// synchronous frames, so useInput handlers and TextInput focus behave as in a
// real terminal.

// baseContext builds the Context a screen needs, mirroring what the app pins
// before mounting the TUI: the compiled root Commander command (CommandKey —
// RouterScreen walks it to resolve each menu's subcommands), the global flags
// (region/json/debug), and a no-op JsonRenderer. Compiling the real handler tree
// keeps the command menus faithful to the production command structure.
function baseContext(core: TestCoreClient, endpointUrl?: string): Context {
  const rootCommand = compile(
    createRootHandler(core, {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    }),
    ValueContext.EmptyContext(),
  );

  return ValueContext.EmptyContext()
    .withValue(CommandKey, rootCommand)
    .withValue(RegionKey, "us-east-1")
    .withValue(EndpointKey, endpointUrl)
    .withValue(JsonKey, false)
    .withValue(DebugKey, false)
    .withValue(JsonRendererKey, { renderJson: () => {}, renderJsonLine: () => {} });
}

// testQueryClient returns a QueryClient with retries and caching disabled so
// query error/success states settle immediately and deterministically.
function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

export interface RenderScreenOptions {
  // core is the injected Core; defaults to an empty TestCoreClient.
  core?: TestCoreClient;
  // ctx overrides the base context (rarely needed).
  ctx?: Context;
  // withContext adds screen-specific launch values to the otherwise real base context.
  withContext?: (ctx: Context) => Context;
  // queryClient overrides the deterministic default when a test needs to
  // exercise cache behavior.
  queryClient?: QueryClient;
  endpointUrl?: string;
}

export interface RenderScreenResult {
  core: TestCoreClient;
  // lastFrame returns the most recently rendered frame's text.
  lastFrame: () => string | undefined;
  // frames is every frame rendered so far.
  frames: string[];
  // write sends raw input to the fake stdin, then yields a tick so any newly
  // mounted screen's useInput handler has registered before the next action.
  // (useInput subscribes in a post-paint effect; a real terminal's human-speed
  // input hides the gap, but programmatic bursts can outrun it.)
  write: (input: string) => Promise<void>;
  // press sends a named key (e.g. "return", "escape", "down"), then yields a tick
  // for the same reason as `write`.
  press: (key: keyof typeof keys) => Promise<void>;
  resize: (columns: number, rows?: number) => Promise<void>;
  rerender: () => void;
  unmount: () => void;
}

interface ResizableStdout {
  readonly columns: number;
  readonly rows?: number;
  emit(event: "resize"): boolean;
}

function setWindowSize(stdout: ResizableStdout, columns: number, rows: number): void {
  Object.defineProperties(stdout, {
    columns: { configurable: true, value: columns },
    rows: { configurable: true, value: rows },
  });
  stdout.emit("resize");
}

// keys maps friendly names to the escape sequences Ink decodes into key events.
export const keys = {
  return: "\r",
  escape: "\u001B[27u",
  up: "[A",
  down: "[B",
  left: "[D",
  right: "[C",
} as const;

// cleanupScreens unmounts every screen rendered so far. ink-testing-library
// keeps mounted instances in a module-level list and does not clean them up
// between tests; left alone, stale instances accumulate and compete for stdin,
// so key presses in later tests get lost. Call this in an afterEach.
export function cleanupScreens(): void {
  cleanup();
}

// renderScreen mounts the app's Root at `path` (e.g. "/agentcore/harness/list")
// and returns handles to read frames and send input.
export function renderScreen(path: string, options: RenderScreenOptions = {}): RenderScreenResult {
  const core = options.core ?? new TestCoreClient();
  const base = options.ctx ?? baseContext(core, options.endpointUrl);
  const ctx = options.withContext?.(base) ?? base;
  const queryClient = options.queryClient ?? testQueryClient();

  const instance = render(<></>);
  setWindowSize(instance.stdout, 100, 40);
  instance.rerender(<Root path={path} ctx={ctx} core={core} queryClient={queryClient} />);

  return {
    core,
    lastFrame: instance.lastFrame,
    frames: instance.frames,
    write: async (input: string) => {
      // Tick before writing so the current screen's useInput effect (which
      // subscribes the handler after paint) has run — a frame can be painted
      // before its input handler is live. Tick after so the result settles.
      await tick();
      instance.stdin.write(input);
      await tick();
    },
    press: async (key) => {
      await tick();
      instance.stdin.write(keys[key]);
      await tick();
    },
    resize: async (columns, rows = 40) => {
      setWindowSize(instance.stdout, columns, rows);
      await waitFor(() => {
        const lines = (instance.lastFrame() ?? "").split("\n");
        return lines.length === rows && Math.max(...lines.map((line) => line.length)) === columns;
      });
    },
    rerender: () =>
      instance.rerender(<Root path={path} ctx={ctx} core={core} queryClient={queryClient} />),
    unmount: instance.unmount,
  };
}

// waitForText resolves once `text` appears in the latest frame.
export function waitForText(
  lastFrame: () => string | undefined,
  text: string,
  timeoutMs = 1000,
): Promise<void> {
  return waitFor(() => (lastFrame() ?? "").includes(text), timeoutMs);
}

// flatFrame collapses a frame's whitespace so text that Ink lays out across
// columns or lines (a key/value table, a wrapped sentence) can be matched as a
// single string.
export function flatFrame(lastFrame: () => string | undefined): string {
  return (lastFrame() ?? "").replace(/\s+/g, " ");
}

// waitForFlatText is waitForText against the flattened frame.
export function waitForFlatText(
  lastFrame: () => string | undefined,
  text: string,
  timeoutMs = 1000,
): Promise<void> {
  return waitFor(() => flatFrame(lastFrame).includes(text), timeoutMs);
}
