import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { AppIO } from "./types";
import {
  InteractiveTerminal,
  type InteractiveTerminalPeer,
  type TerminalFrame,
} from "./interactiveTerminal";
import { StreamController } from "../testing";

type TestStdin = NodeJS.ReadStream & {
  write(chunk: Uint8Array | string): boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): TestStdin;
};

function terminalIO(): {
  io: AppIO;
  stdin: TestStdin;
  stdout: () => string;
  stderr: () => string;
  rawModes: boolean[];
} {
  const stdin = new PassThrough() as unknown as TestStdin;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  const rawModes: boolean[] = [];
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => {
    rawModes.push(mode);
    stdin.isRaw = mode;
    return stdin;
  };
  Object.defineProperty(stdin, "isTTY", { value: true });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { configurable: true, value: 120 },
    rows: { configurable: true, value: 35 },
  });
  stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  stdout.on("data", (chunk) => {
    stdoutText += chunk.toString();
  });
  return {
    io: {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    stdin,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    rawModes,
  };
}

class FakePeer implements InteractiveTerminalPeer {
  readonly frames = new StreamController<TerminalFrame>();
  readonly sent: Uint8Array[] = [];
  readonly resizes: { columns: number; rows: number }[] = [];
  closed = 0;

  send(data: Uint8Array): Promise<void> {
    this.sent.push(Uint8Array.from(data));
    return Promise.resolve();
  }

  resize(columns: number, rows: number): Promise<void> {
    this.resizes.push({ columns, rows });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    this.frames.end();
    return Promise.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<TerminalFrame> {
    return this.frames[Symbol.asyncIterator]();
  }
}

const activeTerminals: InteractiveTerminal[] = [];

afterEach(async () => {
  await Promise.all(activeTerminals.splice(0).map((terminal) => terminal.stop()));
});

function subject() {
  const streams = terminalIO();
  let resizeListener: (() => void) | undefined;
  let removed = 0;
  const terminal = new InteractiveTerminal({
    io: streams.io,
    dimensions: () => ({
      columns: streams.io.stdout.columns ?? 80,
      rows: streams.io.stdout.rows ?? 24,
    }),
    onResize: (listener) => {
      resizeListener = listener;
      return () => {
        removed += 1;
        resizeListener = undefined;
      };
    },
  });
  activeTerminals.push(terminal);
  return {
    ...streams,
    terminal,
    resize: () => resizeListener?.(),
    resizeRemoved: () => removed,
  };
}

describe("InteractiveTerminal", () => {
  test("forwards raw stdin and remote output, then restores terminal state", async () => {
    const s = subject();
    const peer = new FakePeer();
    const running = s.terminal.run(peer);
    await Bun.sleep(0);

    s.stdin.write(Uint8Array.from([0x1b, 0x5b, 0x41]));
    peer.frames.emit({ type: "stdout", data: new TextEncoder().encode("out") });
    peer.frames.emit({ type: "stderr", data: new TextEncoder().encode("err") });
    peer.frames.end();

    await running;
    expect(peer.sent).toEqual([Uint8Array.from([0x1b, 0x5b, 0x41])]);
    expect(s.stdout()).toBe("out");
    expect(s.stderr()).toBe("err");
    expect(s.rawModes).toEqual([true, false]);
    expect(s.resizeRemoved()).toBe(1);
  });

  test("sends initial and subsequent terminal dimensions", async () => {
    const s = subject();
    const peer = new FakePeer();
    const running = s.terminal.run(peer);
    await Bun.sleep(0);

    expect(peer.resizes).toEqual([{ columns: 120, rows: 35 }]);
    Object.defineProperties(s.io.stdout, {
      columns: { configurable: true, value: 90 },
      rows: { configurable: true, value: 20 },
    });
    s.resize();
    await Bun.sleep(0);
    expect(peer.resizes).toEqual([
      { columns: 120, rows: 35 },
      { columns: 90, rows: 20 },
    ]);

    peer.frames.end();
    await running;
  });

  test("forwards Ctrl+C and Ctrl+] as raw input", async () => {
    const s = subject();
    const peer = new FakePeer();
    const running = s.terminal.run(peer);
    await Bun.sleep(0);

    s.stdin.write(Uint8Array.from([0x03]));
    s.stdin.write(Uint8Array.from([0x1d]));
    await Bun.sleep(0);
    peer.frames.end();

    await running;
    expect(peer.sent).toEqual([Uint8Array.from([0x03]), Uint8Array.from([0x1d])]);
    expect(peer.closed).toBe(0);
    expect(s.rawModes).toEqual([true, false]);
  });

  test("closes the peer and restores terminal state when aborted", async () => {
    const s = subject();
    const peer = new FakePeer();
    const controller = new AbortController();
    const interrupted = new Error("interrupted");
    const running = s.terminal.run(peer, controller.signal);
    await Bun.sleep(0);

    controller.abort(interrupted);

    await expect(running).rejects.toBe(interrupted);
    expect(peer.closed).toBe(1);
    expect(s.rawModes).toEqual([true, false]);
    expect(s.resizeRemoved()).toBe(1);
  });

  test("restores terminal state when the remote stream fails", async () => {
    const s = subject();
    const failure = new Error("stream failed");
    const peer: InteractiveTerminalPeer = {
      send: async () => {},
      resize: async () => {},
      close: async () => {},
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<TerminalFrame>> => {
            throw failure;
          },
        };
      },
    };

    await expect(s.terminal.run(peer)).rejects.toBe(failure);
    expect(s.rawModes).toEqual([true, false]);
    expect(s.resizeRemoved()).toBe(1);
  });
});
