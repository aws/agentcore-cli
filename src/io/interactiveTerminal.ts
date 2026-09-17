import type { AppIO } from "./types";

const DETACH_BYTE = 0x1d;

export type TerminalFrame =
  { type: "stdout"; data: Uint8Array } | { type: "stderr"; data: Uint8Array };

export interface InteractiveTerminalPeer extends AsyncIterable<TerminalFrame> {
  send(data: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  detach(): Promise<void>;
}

export type InteractiveTerminalResult = {
  detached: boolean;
};

export type InteractiveTerminalConfig = {
  io: AppIO;
  dimensions?: () => { columns: number; rows: number };
  onResize?: (listener: () => void) => () => void;
};

export class InteractiveTerminal {
  private readonly dimensions: () => { columns: number; rows: number };
  private readonly onResize: (listener: () => void) => () => void;
  private stopCurrent?: () => Promise<void>;

  constructor(private readonly config: InteractiveTerminalConfig) {
    this.dimensions =
      config.dimensions ??
      (() => ({
        columns: config.io.stdout.columns ?? 80,
        rows: config.io.stdout.rows ?? 24,
      }));
    this.onResize =
      config.onResize ??
      ((listener) => {
        process.on("SIGWINCH", listener);
        return () => process.off("SIGWINCH", listener);
      });
  }

  async run(
    peer: InteractiveTerminalPeer,
    signal?: AbortSignal,
  ): Promise<InteractiveTerminalResult> {
    if (this.stopCurrent) throw new Error("InteractiveTerminal is already running");

    const { stdin, stdout, stderr } = this.config.io;
    const wasPaused = stdin.isPaused();
    const wasRaw = (stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
    let detached = false;
    let fail: (error: unknown) => void = () => {};
    let queuedFailure: unknown;
    let hasQueuedFailure = false;
    const failure = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    let pending = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
      pending = pending.then(operation).catch((error) => {
        queuedFailure = error;
        hasQueuedFailure = true;
        fail(error);
      });
    };
    const detach = async () => {
      if (detached) return;
      detached = true;
      await peer.detach();
    };
    this.stopCurrent = detach;

    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (bytes.length === 1 && bytes[0] === DETACH_BYTE) {
        enqueue(detach);
        return;
      }
      enqueue(() => peer.send(bytes));
    };
    const resize = () => {
      const { columns, rows } = this.dimensions();
      enqueue(() => peer.resize(columns, rows));
    };
    const removeResize = this.onResize(resize);
    const abort = () => {
      enqueue(async () => {
        await detach();
        throw signal?.reason ?? new Error("terminal interrupted");
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    try {
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume();
      resize();

      const pump = async () => {
        for await (const frame of peer) {
          const output = frame.type === "stdout" ? stdout : stderr;
          output.write(frame.data);
        }
      };
      await Promise.race([pump(), failure]);
      await pending;
      if (hasQueuedFailure) throw queuedFailure;
      return { detached };
    } finally {
      signal?.removeEventListener("abort", abort);
      removeResize();
      stdin.off("data", onData);
      if (wasPaused) stdin.pause();
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
      this.stopCurrent = undefined;
    }
  }

  async stop(): Promise<void> {
    await this.stopCurrent?.();
  }
}
