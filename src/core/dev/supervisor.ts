import { connect } from "node:net";
import { ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner } from "../../handlers/project/dev/types";
import type { ProjectRuntime } from "../../projectSchemas/runtime";

export type AgentPhase = "idle" | "starting" | "running" | "failed";

export interface AgentStatus {
  name: string;
  buildType: ProjectRuntime["build"];
  protocol: NonNullable<ProjectRuntime["protocol"]>;
  phase: AgentPhase;
  port?: number;
  error?: string;
}

/** A dev event attributed to the agent that produced it. */
export interface SupervisedEvent {
  agent: string;
  event: DevEvent;
}

export type SupervisorConfig = {
  runtimes: ProjectRuntime[];
  projectRoot: string;
  runners: { CodeZip: DevRunner; Container: DevRunner };
  /** Resolves the full child environment for a runtime (dev env + OTEL vars). */
  environment: (runtime: ProjectRuntime) => Promise<Record<string, string>>;
  /** Resolves the port a runtime should serve on. */
  resolvePort: (runtime: ProjectRuntime) => Promise<number>;
  /** Resolves once a started agent accepts connections on its port. */
  waitReady?: (port: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
};

type AgentEntry = {
  runtime: ProjectRuntime;
  phase: AgentPhase;
  port?: number;
  error?: string;
  starting?: Promise<{ name: string; port: number }>;
};

/**
 * Owns the lifecycle of every dev-able runtime for the Inspector: agents start
 * lazily (triggered from the browser), each in its own abort scope chained off
 * the command's signal, and every runner's events merge into one attributed
 * stream the dev handler renders. Restart-on-edit stays inside the child
 * (uvicorn --reload / tsx watch) — the supervisor never restarts processes.
 */
export class DevSupervisor {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly queue: SupervisedEvent[] = [];
  private wake: (() => void) | undefined;
  private readonly waitReady: (port: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly config: SupervisorConfig) {
    for (const runtime of config.runtimes) {
      this.agents.set(runtime.name, { runtime, phase: "idle" });
    }
    this.waitReady = config.waitReady ?? waitForPort;
    config.signal.addEventListener("abort", () => this.wake?.(), { once: true });
  }

  /**
   * Replace the managed runtime set after a config change: new runtimes join
   * idle, edited definitions apply on the next start, and removed runtimes
   * drop unless they are currently starting or running.
   */
  public setRuntimes(runtimes: ProjectRuntime[]): void {
    const names = new Set(runtimes.map((runtime) => runtime.name));
    for (const runtime of runtimes) {
      const existing = this.agents.get(runtime.name);
      if (existing) existing.runtime = runtime;
      else this.agents.set(runtime.name, { runtime, phase: "idle" });
    }
    for (const [name, entry] of this.agents) {
      if (!names.has(name) && entry.phase !== "running" && entry.phase !== "starting") {
        this.agents.delete(name);
      }
    }
  }

  /** Current phase, port, and last error of every managed agent. */
  public snapshot(): AgentStatus[] {
    return [...this.agents.values()].map(({ runtime, phase, port, error }) => ({
      name: runtime.name,
      buildType: runtime.build,
      protocol: runtime.protocol ?? "HTTP",
      phase,
      port,
      error,
    }));
  }

  /** The port and protocol of a running agent, for proxying requests to it. */
  public running(
    name: string,
  ): { port: number; protocol: NonNullable<ProjectRuntime["protocol"]> } | undefined {
    const entry = this.agents.get(name);
    if (entry?.phase !== "running" || entry.port === undefined) return undefined;
    return { port: entry.port, protocol: entry.runtime.protocol ?? "HTTP" };
  }

  /**
   * Start an agent by name, resolving once it accepts connections. Concurrent
   * and repeated starts of the same agent share one attempt; a previously
   * failed agent may be started again.
   */
  public start(name: string): Promise<{ name: string; port: number }> {
    const entry = this.agents.get(name);
    if (!entry) {
      const available = [...this.agents.keys()].join(", ");
      throw new ResourceNotFoundError(
        `Agent '${name}' was not found. Available agents: ${available}.`,
      );
    }
    if (entry.phase === "running" && entry.port !== undefined) {
      return Promise.resolve({ name, port: entry.port });
    }
    if (entry.starting) return entry.starting;

    entry.starting = this.launch(entry).finally(() => {
      entry.starting = undefined;
    });
    return entry.starting;
  }

  /**
   * The merged event stream of every agent this supervisor has started. Ends
   * when the supervisor's signal aborts and all pending events are drained.
   */
  public async *events(): AsyncGenerator<SupervisedEvent, void> {
    while (true) {
      for (const event of this.queue.splice(0)) yield event;
      if (this.config.signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        // A push during the yields above ran while wake was undefined, so its
        // wake was a no-op. Re-check now that wake is installed, so a queued
        // event resolves immediately instead of waiting for the next push.
        if (this.queue.length > 0) resolve();
      });
      this.wake = undefined;
    }
  }

  private push(agent: string, event: DevEvent): void {
    this.queue.push({ agent, event });
    this.wake?.();
  }

  private async launch(entry: AgentEntry): Promise<{ name: string; port: number }> {
    const name = entry.runtime.name;
    entry.phase = "starting";
    entry.error = undefined;

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    // Chained for the agent's whole lifetime (not just startup): the command's
    // Ctrl-C must tear down every running child. The pump removes it on exit.
    this.config.signal.addEventListener("abort", onParentAbort, { once: true });
    const unchain = () => this.config.signal.removeEventListener("abort", onParentAbort);

    try {
      const port = await this.config.resolvePort(entry.runtime);
      const env = await this.config.environment(entry.runtime);
      const runner = this.config.runners[entry.runtime.build];

      let ready = false;
      const readiness = this.waitReady(port, controller.signal).then(() => {
        ready = true;
      });
      const earlyExit = this.pump(entry, runner, { port, env, signal: controller.signal })
        .finally(unchain)
        .then(() => {
          if (!ready)
            throw new Error(entry.error ?? `Agent '${name}' exited before it became ready.`);
        });
      // Both branches outlive the race (the pump runs for the agent's lifetime);
      // swallow their late rejections so losing branches never become unhandled.
      readiness.catch(() => {});
      earlyExit.catch(() => {});
      await Promise.race([readiness, earlyExit]);

      entry.phase = "running";
      entry.port = port;
      this.push(name, { type: "status", message: `Agent '${name}' is running on port ${port}.` });
      return { name, port };
    } catch (error) {
      controller.abort();
      unchain(); // idempotent alongside the pump's cleanup; covers setup failures before the pump exists
      entry.phase = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      this.push(name, {
        type: "status",
        message: `Agent '${name}' failed to start: ${entry.error}`,
      });
      throw error;
    }
  }

  /** Drives one runner generator, attributing its events; resolves when the runner ends. */
  private async pump(
    entry: AgentEntry,
    runner: DevRunner,
    input: { port: number; env: Record<string, string>; signal: AbortSignal },
  ): Promise<void> {
    const name = entry.runtime.name;
    try {
      for await (const event of runner.run({
        runtime: entry.runtime,
        projectRoot: this.config.projectRoot,
        port: input.port,
        env: input.env,
        signal: input.signal,
      })) {
        this.push(name, event);
      }
      if (entry.phase === "running") {
        entry.phase = "idle";
        entry.port = undefined;
        this.push(name, { type: "status", message: `Agent '${name}' stopped.` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.error = message;
      if (entry.phase === "running") {
        entry.phase = "failed";
        entry.port = undefined;
        this.push(name, { type: "status", message: `Agent '${name}' crashed: ${message}` });
      }
    }
  }
}

/** Generous enough for a cold dependency install before the server first binds. */
const READY_TIMEOUT_MS = 120_000;

/**
 * Poll until a loopback TCP connection to `port` succeeds, the signal aborts,
 * or the deadline passes — a child that stays alive without ever binding must
 * fail its start instead of blocking every later runtime.
 */
export function waitForPort(
  port: number,
  signal: AbortSignal,
  intervalMs = 250,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal.aborted) {
        reject(new Error("Aborted while waiting for the agent to become ready."));
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Agent did not accept connections on port ${port} within ${timeoutMs / 1000}s.`,
          ),
        );
        return;
      }
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}
