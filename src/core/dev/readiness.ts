import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { isContainerBuild } from "../../projectSchemas/constants";
import type { PortChecker } from "../../io";
import { DEV_PORTS, findFreePort } from "./port";

/** The header AgentCore Runtime sets on build warmup calls; its value is the warmup type. */
export const WARMUP_TYPE_HEADER = "x-amzn-bedrock-agentcore-runtime-warmup-type";
/** The `memory` and `disk` calls share this budget on AgentCore Runtime. */
export const WARMUP_BUDGET_MS = 120_000;
/** The service calls `memory` (before the snapshot), then `disk` (on a restored microVM). */
export const WARMUP_TYPES = ["memory", "disk"] as const;

const PING_INTERVAL_MS = 250;
const PING_REQUEST_TIMEOUT_MS = 2_000;
const PING_TIMEOUT_MS = 120_000;
/** Compared case-insensitively: ag_ui_strands' `add_ping` reports `"healthy"`. */
const HEALTHY_STATUSES = new Set(["healthy", "healthybusy"]);

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where dev sends a runtime's build warmup hook. */
export type WarmupTarget = {
  path: string;
  port: number;
  /** The hook is a container's own port, reached through an extra port mapping. */
  viaContainerMapping?: boolean;
  /**
   * MCP servers don't have to serve `/ping`: the service treats any response other than 502 or 429
   * as ready, including a 404. Every other protocol must report Healthy.
   */
  anyPingResponse?: boolean;
  /** Added to a startup or warmup failure when dev knows a likely cause. */
  hint?: string;
};

/**
 * The in-container port of a container runtime's build warmup hook when it isn't the serving
 * port, so dev has to publish it with its own port mapping. Undefined in every other case.
 */
export function containerHookPort(runtime: ProjectRuntime): number | undefined {
  const port = runtime.hooksConfiguration?.build?.warmup?.action.httpPost.port;
  if (port === undefined || !isContainerBuild(runtime)) return undefined;
  return port === DEV_PORTS[runtime.protocol ?? "HTTP"] ? undefined : port;
}

/**
 * The local address of a runtime's build warmup hook, or undefined when it has none.
 *
 * A hook on the serving port, which is the default, is reached on the agent's dev port in both
 * builds. A CodeZip hook on its own port is a local listener. A container's own-port hook is
 * reached through the extra mapping dev publishes for it, on `hookHostPort`.
 */
export function warmupTarget(
  runtime: ProjectRuntime,
  devPort: number,
  hookHostPort?: number,
): WarmupTarget | undefined {
  const httpPost = runtime.hooksConfiguration?.build?.warmup?.action.httpPost;
  if (!httpPost) return undefined;
  const { path, port } = httpPost;
  if (!path.startsWith("/")) {
    throw new Error(
      `Runtime '${runtime.name}' has warmup hook path "${path}", which must start with "/" ` +
        `(for example "/${path}"). AgentCore Runtime rejects it too.`,
    );
  }
  const protocol = runtime.protocol ?? "HTTP";
  const servingPort = DEV_PORTS[protocol];
  const base = protocol === "MCP" ? { path, anyPingResponse: true } : { path };
  // The serving port is wherever dev runs the agent, which may not be its configured number.
  if (port === undefined || port === servingPort) return { ...base, port: devPort };
  if (!isContainerBuild(runtime)) {
    return isPythonHttpCodeZip(runtime)
      ? { ...base, port, hint: PYTHON_CODEZIP_HOOK_PORT_HINT }
      : { ...base, port };
  }
  if (hookHostPort !== undefined) return { ...base, port: hookHostPort, viaContainerMapping: true };
  throw new Error(
    `Runtime '${runtime.name}' serves its warmup hook on port ${port}, which agentcore dev can't ` +
      `reach inside a container. Remove "port" from hooksConfiguration.build.warmup.action.httpPost, ` +
      `or set it to the serving port (${servingPort}), to run the hook locally.`,
  );
}

const PYTHON_CODEZIP_HOOK_PORT_HINT =
  "agentcore dev runs Python CodeZip agents under uvicorn, where the SDK's HookConfig(port=...) " +
  'isn\'t served (it needs app.run()). To run the hook locally, remove "port" from ' +
  "hooksConfiguration.build.warmup.action.httpPost so it's served on the serving port.";

/** dev runs these with `uvicorn --reload` instead of the agent's own `app.run()`. */
function isPythonHttpCodeZip(runtime: ProjectRuntime): boolean {
  const file = runtime.entrypoint.split(":")[0] ?? "";
  return (runtime.protocol ?? "HTTP") === "HTTP" && file.endsWith(".py");
}

/**
 * A warning for a `hooksConfiguration` that dev and the service won't recognize as a warmup hook.
 * The schema keeps unknown keys so new service fields pass through, which also lets PascalCase
 * keys (`Build`) and typos (`warmUp`) through. Undefined when the hook is recognized or unset.
 */
export function hooksConfigurationWarning(
  runtime: Pick<ProjectRuntime, "name" | "hooksConfiguration">,
): string | undefined {
  const hooks = runtime.hooksConfiguration;
  if (!hooks || Object.keys(hooks).length === 0) return undefined;
  // Optional chaining throughout: `add` checks the raw flag value before the schema does.
  if (hooks.build?.warmup?.action?.httpPost?.path) return undefined;
  return (
    `Runtime '${runtime.name}' has a hooksConfiguration without build.warmup.action.httpPost.path. ` +
    "Keys are camelCase (build, warmup, action, httpPost), so agentcore dev skips the warmup, " +
    "and AgentCore Runtime may reject the hook at deploy."
  );
}

/**
 * For agents started together: CodeZip agents whose warmup hooks listen on the same own port of
 * this machine. Only one of them can bind it, so the other's warmup would reach the wrong agent.
 */
export function sharedHookPortError(runtimes: ProjectRuntime[]): string | undefined {
  const byPort = new Map<number, string[]>();
  for (const runtime of runtimes) {
    if (isContainerBuild(runtime)) continue;
    const port = runtime.hooksConfiguration?.build?.warmup?.action.httpPost.port;
    if (port === undefined || port === DEV_PORTS[runtime.protocol ?? "HTTP"]) continue;
    byPort.set(port, [...(byPort.get(port) ?? []), runtime.name]);
  }
  const clashes = [...byPort].filter(([, names]) => names.length > 1);
  if (clashes.length === 0) return undefined;
  const described = clashes
    .map(([port, names]) => `${names.map((name) => `'${name}'`).join(" and ")} on port ${port}`)
    .join("; ");
  return (
    `Agents serve their warmup hooks on the same port of this machine (${described}), so only ` +
    "one of them can listen there. Give each hook its own port, or run the agents one at a time " +
    "with --agent."
  );
}

/**
 * Poll `GET /ping` until it reports Healthy or HealthyBusy, the signal aborts, or `timeoutMs`
 * passes. AgentCore Runtime calls the warmup hook only after this check passes. The deadline is
 * fixed: each poll makes the agent log a line, so a deadline based on its output would never pass.
 * With `anyResponse` (MCP), any response other than 502 or 429 counts, as it does for the service.
 */
export async function waitForHealthyPing(
  port: number,
  signal: AbortSignal,
  fetchImpl: HttpFetch,
  intervalMs = PING_INTERVAL_MS,
  timeoutMs = PING_TIMEOUT_MS,
  anyResponse = false,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/ping`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for /ping to report healthy.");
    if (Date.now() > deadline) {
      throw new Error(
        anyResponse
          ? `GET /ping on port ${port} got no response other than 502 or 429 within ${timeoutMs / 1000}s.`
          : `GET /ping on port ${port} did not report Healthy within ${timeoutMs / 1000}s.`,
      );
    }
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.any([signal, AbortSignal.timeout(PING_REQUEST_TIMEOUT_MS)]),
      });
      if (anyResponse && response.status !== 502 && response.status !== 429) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { status?: unknown } | undefined;
        if (typeof body?.status === "string" && HEALTHY_STATUSES.has(body.status.toLowerCase())) {
          return;
        }
      }
    } catch {
      // Not listening yet, or a slow or malformed response: retry until the deadline.
    }
    await sleep(intervalMs, signal);
  }
}

/**
 * Send the build warmup calls the way AgentCore Runtime does: `POST <path>` with the warmup type
 * header, no body and no Content-Type, `memory` then `disk`, within one shared budget.
 * Any non-2xx response or a timeout fails, as it fails a V2 create or update.
 */
export async function runWarmupHook(
  target: WarmupTarget,
  signal: AbortSignal,
  fetchImpl: HttpFetch,
  onCall: (type: (typeof WARMUP_TYPES)[number]) => void = () => {},
  budgetMs = WARMUP_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const url = `http://127.0.0.1:${target.port}${target.path}`;
  for (const type of WARMUP_TYPES) {
    const remaining = deadline - Date.now();
    const describe = `warmup ${type} call (POST ${target.path} on port ${target.port})`;
    if (remaining <= 0)
      throw new Error(
        `The ${describe} did not start within the ${budgetMs / 1000}s warmup budget.`,
      );
    onCall(type);
    const budget = AbortSignal.timeout(remaining);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { [WARMUP_TYPE_HEADER]: type },
        signal: AbortSignal.any([signal, budget]),
      });
    } catch (error) {
      if (budget.aborted) {
        throw new Error(
          `The ${describe} did not finish within the ${budgetMs / 1000}s warmup budget.`,
        );
      }
      const hint = target.viaContainerMapping
        ? " If the hook listens only on the container's loopback (for example the SDK's HookConfig.port)," +
          " dev can't reach it: leave the port unset so it's served on the serving port."
        : "";
      throw new Error(`The ${describe} failed: ${fetchErrorMessage(error)}${hint}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
      throw new Error(`The ${describe} returned ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
  }
}

/** A runtime's warmup hook as dev runs it: the host port to publish for it, and where to call it. */
export type WarmupPlan = { hookPort?: number; target?: WarmupTarget };

/**
 * Resolves where dev calls a runtime's build warmup hook, reserving a host port first when a
 * container's hook has its own port. `reserveHookPort` picks a free host port, preferring the
 * hook's own number. Throws before the agent starts when the hook can't be reached.
 */
export async function planWarmup(
  runtime: ProjectRuntime,
  devPort: number,
  reserveHookPort: (preferred: number) => Promise<number>,
): Promise<WarmupPlan> {
  const ownPort = containerHookPort(runtime);
  const hookPort = ownPort === undefined ? undefined : await reserveHookPort(ownPort);
  return { hookPort, target: warmupTarget(runtime, devPort, hookPort) };
}

/**
 * What AgentCore Runtime V2 does before an agent with a build warmup hook is ready: a healthy
 * `GET /ping`, then the `memory` and `disk` warmup calls. Call it once the agent's port is open.
 */
export async function runWarmupSequence(options: {
  name: string;
  devPort: number;
  target: WarmupTarget;
  signal: AbortSignal;
  fetchImpl: HttpFetch;
  onStatus: (message: string) => void;
}): Promise<void> {
  const { name, devPort, target, signal, fetchImpl, onStatus } = options;
  onStatus(
    target.anyPingResponse
      ? `Waiting for '${name}' to answer GET /ping (any response but 502 or 429, as for MCP on AgentCore Runtime).`
      : `Waiting for '${name}' to report healthy on GET /ping.`,
  );
  await waitForHealthyPing(
    devPort,
    signal,
    fetchImpl,
    undefined,
    undefined,
    target.anyPingResponse,
  );
  await runWarmupHook(target, signal, fetchImpl, (type) =>
    onStatus(
      `Running the warmup hook for '${name}' (${type}): POST ${target.path} on port ${target.port}.`,
    ),
  );
  onStatus(
    `Warmup hook for '${name}' succeeded. Locally both calls run in one process, so state that ` +
      "doesn't survive a V2 snapshot isn't caught here, and a code reload doesn't rerun the hook.",
  );
}

/**
 * Resolves once a started agent is ready the way AgentCore Runtime V2 sees it: its port accepts
 * connections and, when it has a build warmup hook, `/ping` is healthy and both warmup calls passed.
 * The supervisor and `dev --agent` both start agents through this.
 */
export async function waitUntilReady(options: {
  name: string;
  devPort: number;
  warmup?: WarmupTarget;
  waitForPort: () => Promise<void>;
  signal: AbortSignal;
  fetchImpl: HttpFetch;
  onStatus: (message: string) => void;
}): Promise<void> {
  const { warmup, waitForPort, ...sequence } = options;
  if (warmup?.hint) sequence.onStatus(`Warning: ${warmup.hint}`);
  try {
    await waitForPort();
    if (warmup) await runWarmupSequence({ ...sequence, target: warmup });
  } catch (error) {
    if (!warmup?.hint || !(error instanceof Error) || sequence.signal.aborted) throw error;
    throw new Error(`${error.message} ${warmup.hint}`, { cause: error });
  }
}

/**
 * Reserves host ports for container warmup hooks among ports already taken by dev, one at a time
 * so agents starting together can't claim the same port. Seed it with the dev ports in use.
 */
export class HookPortReserver {
  private readonly reserved: Set<number>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly checkPort: PortChecker,
    private readonly signal: AbortSignal,
    reserved: Iterable<number> = [],
  ) {
    this.reserved = new Set(reserved);
  }

  /** Marks a port dev already uses, such as an agent's dev port picked later. */
  public add(port: number): void {
    this.reserved.add(port);
  }

  public isReserved(port: number): boolean {
    return this.reserved.has(port);
  }

  public reserve(preferred: number): Promise<number> {
    const next = this.queue.then(async () => {
      const { port } = await findFreePort(
        preferred,
        undefined,
        async (candidate, checkSignal) =>
          !this.reserved.has(candidate) && this.checkPort(candidate, checkSignal),
        this.signal,
      );
      this.reserved.add(port);
      return port;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/** A fetch failure's message, without the runtime's "pass verbose: true" advice, ending in a period. */
function fetchErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s*For more information, pass `verbose: true`[^.]*\./, "")
    .trim();
  return message.endsWith(".") ? message : `${message}.`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
