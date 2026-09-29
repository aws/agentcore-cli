import { test, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { waitFor } from "../../testing";
import { useWindowSize } from "./useWindowSize";

afterEach(cleanup);

function Size({ label }: { label: string }) {
  const { columns, rows } = useWindowSize();
  return (
    <Text>
      {label}:{columns}x{rows}
    </Text>
  );
}

function Many({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Size key={i} label={String(i)} />
      ))}
    </>
  );
}

function resize(stdout: EventEmitter, columns: number, rows: number) {
  Object.defineProperties(stdout, {
    columns: { configurable: true, value: columns },
    rows: { configurable: true, value: rows },
  });
  stdout.emit("resize");
}

test("every consumer shares one resize listener", async () => {
  const instance = render(<Many count={20} />);
  const stdout = instance.stdout as unknown as EventEmitter;
  const inkListeners = stdout.listenerCount("resize");
  resize(stdout, 90, 30);
  await waitFor(() => (instance.lastFrame() ?? "").includes("19:90x30"));

  const listeners = stdout.listenerCount("resize");
  instance.rerender(<Many count={40} />);
  await waitFor(() => (instance.lastFrame() ?? "").includes("39:90x30"));
  expect(stdout.listenerCount("resize")).toBe(listeners);
  expect(listeners).toBeLessThanOrEqual(inkListeners + 1);
});

test("re-renders every consumer with the new size on resize", async () => {
  const instance = render(<Many count={3} />);
  const stdout = instance.stdout as unknown as EventEmitter;
  resize(stdout, 70, 12);
  await waitFor(() => {
    const frame = instance.lastFrame() ?? "";
    return ["0", "1", "2"].every((label) => frame.includes(`${label}:70x12`));
  });
});

test("removes its listener once the last consumer unmounts", async () => {
  const instance = render(<Many count={5} />);
  const stdout = instance.stdout as unknown as EventEmitter;
  resize(stdout, 80, 20);
  await waitFor(() => (instance.lastFrame() ?? "").includes("4:80x20"));
  const mounted = stdout.listenerCount("resize");

  instance.rerender(<Text>none</Text>);
  await waitFor(() => (instance.lastFrame() ?? "").includes("none"));
  expect(stdout.listenerCount("resize")).toBe(mounted - 1);
});
