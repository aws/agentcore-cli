// Push→pull bridges for turning callback-style output into async iteration.
// Producers (process chunk handlers, Toolkit ioHost notifications) push from
// callbacks; consumers pull through `for await`. The queue+wake shape mirrors
// streamProcess in exec.ts, promoted here so generators outside exec can reuse
// it.

/**
 * An unbounded in-memory channel: `push` delivers a value to a waiting consumer
 * or queues it, `close` completes the iteration once the queue drains. Values
 * pushed after `close` are dropped, so a late callback from an already-settled
 * operation cannot wedge a consumer.
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private closed = false;
  private waiters: ((result: IteratorResult<T>) => void)[] = [];

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export type LineSplitter = {
  push(chunk: string): void;
  /** Emits any buffered partial line. Call once, after the source is done. */
  flush(): void;
};

/**
 * Reassembles a stream of arbitrary chunks into complete lines. A chunk can end
 * mid-line (process stdout arrives in fixed-size buffers), so the tail of each
 * chunk is held back until its newline arrives. Blank lines are dropped: they
 * carry nothing a progress tail or an error excerpt could show.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let pending = "";
  const emit = (line: string) => {
    const trimmed = line.trimEnd();
    if (trimmed) onLine(trimmed);
  };
  return {
    push(chunk: string): void {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
    },
    flush(): void {
      if (pending) emit(pending);
      pending = "";
    },
  };
}
