import { describe, expect, test } from "bun:test";
import { AsyncChannel, createLineSplitter } from "./channel";

async function drain<T>(channel: AsyncChannel<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of channel) values.push(value);
  return values;
}

describe("AsyncChannel", () => {
  test("delivers values pushed before the consumer starts, then completes", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();

    expect(await drain(channel)).toEqual([1, 2]);
  });

  test("wakes a consumer waiting for the next value", async () => {
    const channel = new AsyncChannel<string>();
    const draining = drain(channel);
    channel.push("a");
    channel.push("b");
    channel.close();

    expect(await draining).toEqual(["a", "b"]);
  });

  test("drops values pushed after close instead of wedging the consumer", async () => {
    const channel = new AsyncChannel<string>();
    channel.push("kept");
    channel.close();
    channel.push("late");

    expect(await drain(channel)).toEqual(["kept"]);
  });
});

describe("createLineSplitter", () => {
  test("reassembles lines split across chunks", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push("first li");
    splitter.push("ne\nsecond line\npart");
    splitter.push("ial");
    splitter.flush();

    expect(lines).toEqual(["first line", "second line", "partial"]);
  });

  test("drops blank lines and trailing whitespace", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push("one  \n\n  indented\r\n");
    splitter.flush();

    expect(lines).toEqual(["one", "  indented"]);
  });

  test("flush emits nothing when the last chunk ended on a newline", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push("done\n");
    splitter.flush();

    expect(lines).toEqual(["done"]);
  });
});
