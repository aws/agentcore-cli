import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";

import { createStreamSupervisor } from "./streamSupervisor";

type WriteCallback = (error?: Error | null) => void;

type ControlledWritableOptions = Readonly<{
  writeReturn?: boolean;
  onWrite?: (stream: ControlledWritable, callback: WriteCallback) => void;
}>;

const SENTINEL = "underlying-stream-secret";

class ControlledWritable extends EventEmitter {
  readonly calls: Array<Readonly<{ text: string; encoding: BufferEncoding }>> = [];
  maxUnsettledCallbacks = 0;

  readonly #options: ControlledWritableOptions;
  readonly #callbacks: Array<Readonly<{ callback: WriteCallback; settled: boolean }>> = [];
  #unsettledCallbacks = 0;

  constructor(options: ControlledWritableOptions = {}) {
    super();
    this.#options = options;
  }

  write(text: string, encoding: BufferEncoding, callback: WriteCallback): boolean {
    this.calls.push({ text, encoding });
    const entry = { callback, settled: false };
    this.#callbacks.push(entry);
    this.#unsettledCallbacks += 1;
    this.maxUnsettledCallbacks = Math.max(this.maxUnsettledCallbacks, this.#unsettledCallbacks);
    this.#options.onWrite?.(this, callback);
    return this.#options.writeReturn ?? true;
  }

  completeCallback(error?: Error): void {
    const entry = this.#callbacks.find((candidate) => !candidate.settled);
    if (entry === undefined) {
      throw new Error("No pending write callback.");
    }
    (entry as { settled: boolean }).settled = true;
    this.#unsettledCallbacks -= 1;
    entry.callback(error);
  }

  repeatCallback(index: number, error?: Error): void {
    const entry = this.#callbacks[index];
    if (entry === undefined) {
      throw new Error("Unknown write callback.");
    }
    entry.callback(error);
  }

  emitDrain(): void {
    this.emit("drain");
  }

  emitError(message = SENTINEL): void {
    this.emit("error", new Error(message));
  }

  emitClose(): void {
    this.emit("close");
  }

  asWriteStream(): NodeJS.WriteStream {
    return this as unknown as NodeJS.WriteStream;
  }
}

async function pending<T>(promise: Promise<T>): Promise<boolean> {
  return (await Promise.race([promise.then(() => false), Promise.resolve(true)])) === true;
}

async function exerciseWriteFailure(
  failure: "throw" | "callback" | "error" | "close",
): Promise<unknown> {
  const stream = new ControlledWritable({
    onWrite:
      failure === "throw"
        ? () => {
            throw new Error(SENTINEL);
          }
        : undefined,
  });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stdout.writeUtf8("document");

  if (failure === "callback") {
    stream.completeCallback(new Error(SENTINEL));
  } else if (failure === "error") {
    stream.emitError();
  } else if (failure === "close") {
    stream.emitClose();
  }

  const result = await write;
  if ((failure === "error" || failure === "close") && stream.calls.length > 0) {
    stream.completeCallback();
  }
  supervisor.dispose();
  await supervisor.quiesce();
  return result;
}

test("requires callback success when write returns true", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const write = supervisor.stdout.writeUtf8('{"ok":true}\n');

  expect(await pending(write)).toBe(true);
  stream.completeCallback();
  expect(await write).toEqual({ kind: "written" });
  expect(stream.calls).toEqual([{ text: '{"ok":true}\n', encoding: "utf8" }]);

  supervisor.dispose();
  await supervisor.quiesce();
});

test("settles only after callback and drain when write returns false", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stdout.writeUtf8('{"ok":true}\n');
  expect(await Promise.race([write, Promise.resolve("pending")])).toBe("pending");
  stream.completeCallback();
  expect(await Promise.race([write, Promise.resolve("pending")])).toBe("pending");
  stream.emitDrain();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("requires callback and drain when drain arrives first", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stdout.writeUtf8("document");

  stream.emitDrain();
  expect(await pending(write)).toBe(true);
  stream.completeCallback();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("handles a synchronous callback before write returns", async () => {
  const stream = new ControlledWritable({
    writeReturn: false,
    onWrite: (_stream, callback) => callback(),
  });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const write = supervisor.stdout.writeUtf8("document");

  expect(await pending(write)).toBe(true);
  stream.emitDrain();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("contains synchronous throw, callback failure, error, and early close", async () => {
  for (const failure of ["throw", "callback", "error", "close"] as const) {
    const result = await exerciseWriteFailure(failure);
    expect(result).toEqual({ kind: "outputUnavailable" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  }
});

test("contains synchronous error and close events emitted by write", async () => {
  for (const terminal of ["error", "close"] as const) {
    const stream = new ControlledWritable({
      onWrite: (controlled) => {
        if (terminal === "error") {
          controlled.emitError();
        } else {
          controlled.emitClose();
        }
      },
    });
    const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

    const result = await supervisor.stdout.writeUtf8("document");

    expect(result).toEqual({ kind: "outputUnavailable" });
    stream.completeCallback();
    supervisor.dispose();
    await supervisor.quiesce();
  }
});

test("stdout rejects a competing document without splitting, retrying, or queueing", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const first = supervisor.stdout.writeUtf8("first document");
  const competing = supervisor.stdout.writeUtf8("competing document");

  expect(await competing).toEqual({ kind: "outputUnavailable" });
  expect(stream.calls).toEqual([{ text: "first document", encoding: "utf8" }]);
  stream.completeCallback();
  expect(await first).toEqual({ kind: "written" });
  expect(stream.calls).toHaveLength(1);

  supervisor.dispose();
  await supervisor.quiesce();
});

test("stderr serializes writes in invocation order through backpressure", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const first = supervisor.stderr.writeUtf8("first");
  const second = supervisor.stderr.writeUtf8("second");
  const third = supervisor.stderr.writeUtf8("third");

  expect(stream.calls.map((call) => call.text)).toEqual(["first"]);
  stream.emitDrain();
  stream.completeCallback();
  expect(await first).toEqual({ kind: "written" });
  expect(stream.calls.map((call) => call.text)).toEqual(["first", "second"]);

  stream.completeCallback();
  expect(await pending(second)).toBe(true);
  stream.emitDrain();
  expect(await second).toEqual({ kind: "written" });
  expect(stream.calls.map((call) => call.text)).toEqual(["first", "second", "third"]);

  stream.completeCallback();
  stream.emitDrain();
  expect(await third).toEqual({ kind: "written" });
  expect(stream.maxUnsettledCallbacks).toBe(1);

  supervisor.dispose();
  await supervisor.quiesce();
});

test("cancellation before write prevents any underlying call", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const controller = new AbortController();
  controller.abort();

  expect(await supervisor.stdout.writeUtf8("document", { abortSignal: controller.signal })).toEqual(
    { kind: "outputUnavailable" },
  );
  expect(
    await supervisor.stderr.writeUtf8("diagnostic", { abortSignal: controller.signal }),
  ).toEqual({ kind: "outputUnavailable" });
  expect(stream.calls).toEqual([]);

  supervisor.dispose();
  await supervisor.quiesce();
});

test("cancellation removes a queued stderr write before acceptance", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const controller = new AbortController();

  const active = supervisor.stderr.writeUtf8("active");
  const cancelled = supervisor.stderr.writeUtf8("cancelled", {
    abortSignal: controller.signal,
  });
  const following = supervisor.stderr.writeUtf8("following");
  controller.abort();

  expect(await cancelled).toEqual({ kind: "outputUnavailable" });
  expect(stream.calls.map((call) => call.text)).toEqual(["active"]);
  stream.completeCallback();
  expect(await active).toEqual({ kind: "written" });
  expect(stream.calls.map((call) => call.text)).toEqual(["active", "following"]);
  stream.completeCallback();
  expect(await following).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("cancellation after acceptance does not settle before callback", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const controller = new AbortController();

  const write = supervisor.stderr.writeUtf8("diagnostic", {
    abortSignal: controller.signal,
  });
  controller.abort();

  expect(await pending(write)).toBe(true);
  stream.completeCallback();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("cancellation after false-returning acceptance retains callback and drain ownership", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const controller = new AbortController();

  const write = supervisor.stdout.writeUtf8("document", {
    abortSignal: controller.signal,
  });
  controller.abort();
  stream.completeCallback();

  expect(await pending(write)).toBe(true);
  stream.emitDrain();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("quiesce waits through its captured queued-work high-water mark", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const first = supervisor.stderr.writeUtf8("first");
  const second = supervisor.stderr.writeUtf8("second");
  const quiescence = supervisor.quiesce();
  const afterHighWater = supervisor.stderr.writeUtf8("after high water");

  expect(await pending(quiescence)).toBe(true);
  stream.completeCallback();
  await first;
  expect(await pending(quiescence)).toBe(true);
  stream.completeCallback();
  await second;
  expect(await quiescence).toBeUndefined();
  expect(await pending(afterHighWater)).toBe(true);
  stream.completeCallback();
  expect(await afterHighWater).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});

test("dispose rejects new writes and retains listeners until accepted work settles", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const errorBaseline = stream.listenerCount("error");
  const closeBaseline = stream.listenerCount("close");
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stdout.writeUtf8("document");

  expect(stream.listenerCount("error")).toBe(errorBaseline + 1);
  expect(stream.listenerCount("close")).toBe(closeBaseline + 1);
  supervisor.dispose();
  expect(await supervisor.stdout.writeUtf8("late")).toEqual({
    kind: "outputUnavailable",
  });
  expect(stream.calls).toHaveLength(1);

  stream.completeCallback();
  expect(stream.listenerCount("error")).toBe(errorBaseline + 1);
  expect(stream.listenerCount("close")).toBe(closeBaseline + 1);
  stream.emitDrain();
  expect(await write).toEqual({ kind: "written" });
  await supervisor.quiesce();
  expect(stream.listenerCount("error")).toBe(errorBaseline);
  expect(stream.listenerCount("close")).toBe(closeBaseline);
});

test("shared stdout and stderr install and remove one listener pair", async () => {
  const stream = new ControlledWritable();
  const errorBaseline = stream.listenerCount("error");
  const closeBaseline = stream.listenerCount("close");

  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  expect(stream.listenerCount("error")).toBe(errorBaseline + 1);
  expect(stream.listenerCount("close")).toBe(closeBaseline + 1);
  supervisor.dispose();
  supervisor.dispose();
  await supervisor.quiesce();
  expect(stream.listenerCount("error")).toBe(errorBaseline);
  expect(stream.listenerCount("close")).toBe(closeBaseline);
});

test("terminal races and duplicate callbacks settle exactly once without escaping", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  let settlements = 0;
  const write = supervisor.stdout.writeUtf8("document").then((result) => {
    settlements += 1;
    return result;
  });
  const quiescence = supervisor.quiesce();
  supervisor.dispose();

  expect(() => {
    stream.emitError();
    stream.emitClose();
    stream.emitError("duplicate terminal");
    stream.emitDrain();
  }).not.toThrow();
  expect(await write).toEqual({ kind: "outputUnavailable" });
  expect(settlements).toBe(1);
  expect(await pending(quiescence)).toBe(true);

  stream.completeCallback();
  stream.repeatCallback(0, new Error("duplicate callback"));
  expect(await quiescence).toBeUndefined();
  expect(settlements).toBe(1);
  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.listenerCount("close")).toBe(0);
});

test("contains duplicate terminal events after callback success and before drain", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stdout.writeUtf8("document");
  const quiescence = supervisor.quiesce();
  stream.completeCallback();
  supervisor.dispose();

  expect(() => {
    stream.emitError();
    stream.emitClose();
    stream.emitError("duplicate terminal");
  }).not.toThrow();
  expect(await write).toEqual({ kind: "outputUnavailable" });
  await quiescence;
  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.listenerCount("close")).toBe(0);
});

test("repeated quiesce and dispose calls settle consistently", async () => {
  const stream = new ControlledWritable();
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());
  const write = supervisor.stderr.writeUtf8("diagnostic");
  const firstQuiescence = supervisor.quiesce();
  const secondQuiescence = supervisor.quiesce();

  supervisor.dispose();
  supervisor.dispose();
  expect(await pending(firstQuiescence)).toBe(true);
  expect(await pending(secondQuiescence)).toBe(true);
  stream.completeCallback();

  expect(await write).toEqual({ kind: "written" });
  await Promise.all([firstQuiescence, secondQuiescence, supervisor.quiesce()]);
  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.listenerCount("close")).toBe(0);
});

test("empty UTF-8 documents use the same callback and backpressure contract", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream.asWriteStream(), stream.asWriteStream());

  const write = supervisor.stdout.writeUtf8("");

  expect(stream.calls).toEqual([{ text: "", encoding: "utf8" }]);
  stream.emitDrain();
  expect(await pending(write)).toBe(true);
  stream.completeCallback();
  expect(await write).toEqual({ kind: "written" });

  supervisor.dispose();
  await supervisor.quiesce();
});
