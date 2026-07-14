import type { AwaitedOutputSink, OutputWriteOutcome, StreamSupervisor } from "./types";

const WRITTEN: OutputWriteOutcome = { kind: "written" };
const OUTPUT_UNAVAILABLE: OutputWriteOutcome = { kind: "outputUnavailable" };

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

type TrackedWork = Readonly<{
  result: Promise<OutputWriteOutcome>;
  settle(outcome: OutputWriteOutcome): void;
  finish(): void;
}>;

type StreamOperation = Readonly<{
  fail(): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

class WorkTracker {
  readonly #pending = new Map<number, Deferred<void>>();
  readonly #onChange: () => void;
  #nextId = 1;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get idle(): boolean {
    return this.#pending.size === 0;
  }

  begin(): TrackedWork {
    const id = this.#nextId;
    this.#nextId += 1;
    const completion = deferred<void>();
    const result = deferred<OutputWriteOutcome>();
    let resultSettled = false;
    let finished = false;
    this.#pending.set(id, completion);

    return {
      result: result.promise,
      settle: (outcome) => {
        if (resultSettled) {
          return;
        }
        resultSettled = true;
        result.resolve(outcome);
      },
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        this.#pending.delete(id);
        completion.resolve();
        this.#onChange();
      },
    };
  }

  quiesce(): Promise<void> {
    const highWaterMark = this.#nextId - 1;
    const captured = [...this.#pending.entries()]
      .filter(([id]) => id <= highWaterMark)
      .map(([, completion]) => completion.promise);
    return Promise.all(captured).then(() => undefined);
  }
}

class SupervisedStream {
  readonly #stream: NodeJS.WriteStream;
  readonly #operations = new Set<StreamOperation>();
  readonly #failureListeners = new Set<() => void>();
  readonly #onStateChange: () => void;
  readonly #onError: (error: Error) => void;
  readonly #onClose: () => void;
  #unavailable = false;
  #detached = false;

  constructor(stream: NodeJS.WriteStream, onStateChange: () => void) {
    this.#stream = stream;
    this.#onStateChange = onStateChange;
    this.#onError = () => {
      this.#fail();
    };
    this.#onClose = () => {
      this.#fail();
    };
    this.#stream.on("error", this.#onError);
    this.#stream.on("close", this.#onClose);
  }

  get unavailable(): boolean {
    return this.#unavailable;
  }

  get hasOperations(): boolean {
    return this.#operations.size > 0;
  }

  onFailure(listener: () => void): void {
    this.#failureListeners.add(listener);
  }

  write(text: string, settle: (outcome: OutputWriteOutcome) => void, finish: () => void): void {
    if (this.#unavailable) {
      settle(OUTPUT_UNAVAILABLE);
      finish();
      return;
    }

    let callbackSeen = false;
    let callbackSucceeded = false;
    let drainSeen = false;
    let writeReturned = false;
    let drainRequired = false;
    let terminal = false;
    let released = false;
    let terminalReleaseScheduled = false;

    const removeDrainListener = () => {
      this.#stream.removeListener("drain", onDrain);
    };
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      removeDrainListener();
      this.#operations.delete(operation);
      finish();
      this.#onStateChange();
    };
    const releaseAfterTerminalTurn = () => {
      if (released || terminalReleaseScheduled) {
        return;
      }
      terminalReleaseScheduled = true;
      queueMicrotask(release);
    };
    const succeedIfComplete = () => {
      if (
        terminal ||
        !writeReturned ||
        !callbackSeen ||
        !callbackSucceeded ||
        (drainRequired && !drainSeen)
      ) {
        return;
      }
      settle(WRITTEN);
      release();
    };
    const failOperation = () => {
      if (!terminal) {
        terminal = true;
        removeDrainListener();
        settle(OUTPUT_UNAVAILABLE);
      }
      if (callbackSeen) {
        releaseAfterTerminalTurn();
      }
    };
    const operation: StreamOperation = {
      fail: failOperation,
    };
    const onDrain = () => {
      drainSeen = true;
      succeedIfComplete();
    };
    const onCallback = (error?: Error | null) => {
      if (callbackSeen) {
        return;
      }
      callbackSeen = true;
      if (error !== undefined && error !== null) {
        this.#fail();
        return;
      }
      callbackSucceeded = true;
      if (terminal) {
        releaseAfterTerminalTurn();
        return;
      }
      succeedIfComplete();
    };

    this.#operations.add(operation);
    this.#stream.on("drain", onDrain);
    try {
      const writeReturn = this.#stream.write(text, "utf8", onCallback);
      writeReturned = true;
      drainRequired = !writeReturn;
      if (!drainRequired) {
        removeDrainListener();
      }
      if (terminal && callbackSeen) {
        releaseAfterTerminalTurn();
        return;
      }
      succeedIfComplete();
    } catch {
      this.#fail();
      release();
    }
  }

  detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#stream.removeListener("error", this.#onError);
    this.#stream.removeListener("close", this.#onClose);
  }

  #fail(): void {
    if (this.#unavailable) {
      return;
    }
    this.#unavailable = true;
    for (const operation of [...this.#operations]) {
      operation.fail();
    }
    for (const listener of this.#failureListeners) {
      listener();
    }
    this.#onStateChange();
  }
}

class StdoutSink implements AwaitedOutputSink {
  readonly #stream: SupervisedStream;
  readonly #tracker: WorkTracker;
  readonly #isDisposed: () => boolean;
  #active: TrackedWork | undefined;

  constructor(stream: SupervisedStream, tracker: WorkTracker, isDisposed: () => boolean) {
    this.#stream = stream;
    this.#tracker = tracker;
    this.#isDisposed = isDisposed;
  }

  writeUtf8(
    text: string,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<OutputWriteOutcome> {
    if (
      this.#isDisposed() ||
      this.#stream.unavailable ||
      isAborted(options?.abortSignal) ||
      this.#active !== undefined
    ) {
      return Promise.resolve(OUTPUT_UNAVAILABLE);
    }

    const work = this.#tracker.begin();
    this.#active = work;
    this.#stream.write(text, work.settle, () => {
      if (this.#active === work) {
        this.#active = undefined;
      }
      work.finish();
    });
    return work.result;
  }
}

type StderrEntry = {
  readonly text: string;
  readonly abortSignal: AbortSignal | undefined;
  readonly work: TrackedWork;
  abortListener: (() => void) | undefined;
  accepted: boolean;
  removed: boolean;
};

class StderrSink implements AwaitedOutputSink {
  readonly #stream: SupervisedStream;
  readonly #tracker: WorkTracker;
  readonly #isDisposed: () => boolean;
  readonly #queue: StderrEntry[] = [];
  #active: StderrEntry | undefined;
  #pumping = false;

  constructor(stream: SupervisedStream, tracker: WorkTracker, isDisposed: () => boolean) {
    this.#stream = stream;
    this.#tracker = tracker;
    this.#isDisposed = isDisposed;
    this.#stream.onFailure(() => {
      this.#failQueue();
    });
  }

  writeUtf8(
    text: string,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<OutputWriteOutcome> {
    const abortSignal = options?.abortSignal;
    if (this.#isDisposed() || this.#stream.unavailable || isAborted(abortSignal)) {
      return Promise.resolve(OUTPUT_UNAVAILABLE);
    }

    const work = this.#tracker.begin();
    const entry: StderrEntry = {
      text,
      abortSignal,
      work,
      abortListener: undefined,
      accepted: false,
      removed: false,
    };
    const abortListener = () => {
      if (entry.accepted || entry.removed) {
        return;
      }
      entry.removed = true;
      this.#removeAbortListener(entry);
      const index = this.#queue.indexOf(entry);
      if (index >= 0) {
        this.#queue.splice(index, 1);
      }
      entry.work.settle(OUTPUT_UNAVAILABLE);
      entry.work.finish();
      this.#pump();
    };
    entry.abortListener = abortListener;
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    this.#queue.push(entry);

    if (isAborted(abortSignal)) {
      abortListener();
    } else {
      this.#pump();
    }
    return work.result;
  }

  #pump(): void {
    if (this.#pumping || this.#active !== undefined) {
      return;
    }
    this.#pumping = true;
    try {
      while (this.#active === undefined) {
        const entry = this.#queue.shift();
        if (entry === undefined) {
          return;
        }
        if (entry.removed) {
          continue;
        }
        if (isAborted(entry.abortSignal) || this.#stream.unavailable) {
          entry.removed = true;
          this.#removeAbortListener(entry);
          entry.work.settle(OUTPUT_UNAVAILABLE);
          entry.work.finish();
          continue;
        }

        entry.accepted = true;
        this.#removeAbortListener(entry);
        this.#active = entry;
        this.#stream.write(entry.text, entry.work.settle, () => {
          if (this.#active === entry) {
            this.#active = undefined;
          }
          entry.removed = true;
          entry.work.finish();
          this.#pump();
        });
      }
    } finally {
      this.#pumping = false;
    }
  }

  #failQueue(): void {
    for (const entry of this.#queue.splice(0)) {
      if (entry.removed) {
        continue;
      }
      entry.removed = true;
      this.#removeAbortListener(entry);
      entry.work.settle(OUTPUT_UNAVAILABLE);
      entry.work.finish();
    }
  }

  #removeAbortListener(entry: StderrEntry): void {
    if (entry.abortListener === undefined) {
      return;
    }
    entry.abortSignal?.removeEventListener("abort", entry.abortListener);
    entry.abortListener = undefined;
  }
}

export function createStreamSupervisor(
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): StreamSupervisor {
  let disposed = false;
  let tracker: WorkTracker;
  const streams: SupervisedStream[] = [];
  const maybeDetach = () => {
    if (!disposed || !tracker.idle || streams.some((stream) => stream.hasOperations)) {
      return;
    }
    for (const stream of streams) {
      stream.detach();
    }
  };
  tracker = new WorkTracker(maybeDetach);

  const contexts = new Map<NodeJS.WriteStream, SupervisedStream>();
  const supervise = (stream: NodeJS.WriteStream): SupervisedStream => {
    const existing = contexts.get(stream);
    if (existing !== undefined) {
      return existing;
    }
    const supervised = new SupervisedStream(stream, maybeDetach);
    contexts.set(stream, supervised);
    streams.push(supervised);
    return supervised;
  };
  const stdoutStream = supervise(stdout);
  const stderrStream = supervise(stderr);
  const isDisposed = () => disposed;

  return {
    stdout: new StdoutSink(stdoutStream, tracker, isDisposed),
    stderr: new StderrSink(stderrStream, tracker, isDisposed),
    quiesce: () => tracker.quiesce(),
    dispose: () => {
      disposed = true;
      maybeDetach();
    },
  };
}
