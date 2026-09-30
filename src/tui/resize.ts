import { EventEmitter } from "node:events";

const ERASE_SCREEN_AND_HOME = "\u001B[2J\u001B[H";
const RESIZE_SETTLE_MS = 100;

type Listener = (...args: unknown[]) => void;

export interface ResizeGate {
  stdout: NodeJS.WriteStream;
  dispose(): void;
}

// Ink renders synchronously for every stdout resize event, bypassing its normal
// frame-rate throttle. During a width reduction that both repaints every column
// and races the terminal's own line wrapping. This facade lets growth through
// immediately, but holds a shrinking size until the resize gesture settles.
// Ink then sees one resize event and redraws once at the final dimensions.
export function createResizeGate(stdout: NodeJS.WriteStream): ResizeGate {
  const resizeEvents = new EventEmitter();
  let columns = stdout.columns;
  let rows = stdout.rows;
  let pendingColumns = columns;
  let pendingRows = rows;
  let shrinking = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let gatedStdout: NodeJS.WriteStream;

  const addListener = (
    method: "on" | "once" | "prependListener" | "prependOnceListener",
    event: string | symbol,
    listener: Listener,
  ): NodeJS.WriteStream => {
    if (event === "resize") resizeEvents[method](event, listener);
    else stdout[method](event, listener);
    return gatedStdout;
  };

  const removeListener = (event: string | symbol, listener: Listener): NodeJS.WriteStream => {
    if (event === "resize") resizeEvents.off(event, listener);
    else stdout.off(event, listener);
    return gatedStdout;
  };

  gatedStdout = new Proxy(stdout, {
    get(target, property) {
      if (property === "columns") return columns;
      if (property === "rows") return rows;
      if (property === "on" || property === "addListener") {
        return (event: string | symbol, listener: Listener) => addListener("on", event, listener);
      }
      if (property === "once") {
        return (event: string | symbol, listener: Listener) => addListener("once", event, listener);
      }
      if (property === "prependListener") {
        return (event: string | symbol, listener: Listener) =>
          addListener("prependListener", event, listener);
      }
      if (property === "prependOnceListener") {
        return (event: string | symbol, listener: Listener) =>
          addListener("prependOnceListener", event, listener);
      }
      if (property === "off" || property === "removeListener") {
        return removeListener;
      }
      if (property === "listenerCount") {
        return (event: string | symbol) =>
          event === "resize" ? resizeEvents.listenerCount(event) : stdout.listenerCount(event);
      }

      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;

  const publish = (clear: boolean) => {
    const changed = columns !== pendingColumns || rows !== pendingRows;
    if (!changed) return;

    if (clear) stdout.write(ERASE_SCREEN_AND_HOME);
    columns = pendingColumns;
    rows = pendingRows;
    resizeEvents.emit("resize");
  };

  const settle = () => {
    settleTimer = undefined;
    const narrowed =
      pendingColumns !== undefined && columns !== undefined && pendingColumns < columns;
    publish(narrowed);
    shrinking = false;
  };

  const onResize = () => {
    pendingColumns = stdout.columns;
    pendingRows = stdout.rows;
    const narrowed =
      pendingColumns !== undefined && columns !== undefined && pendingColumns < columns;
    const shortened = pendingRows !== undefined && rows !== undefined && pendingRows < rows;

    if (shrinking || narrowed || shortened) {
      shrinking = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, RESIZE_SETTLE_MS);
      return;
    }

    publish(false);
  };

  stdout.on("resize", onResize);

  return {
    stdout: gatedStdout,
    dispose() {
      if (settleTimer) clearTimeout(settleTimer);
      stdout.off("resize", onResize);
      resizeEvents.removeAllListeners();
    },
  };
}
