import { test, expect } from "bun:test";
import { testIO } from "../testing";
import { warn } from "./warn";

test("warn writes a prefixed advisory to stderr", () => {
  const io = testIO();
  warn(io.io, "something degraded but not fatal");
  // testIO trims the trailing newline; the "warning: " prefix is what we assert.
  expect(io.stderr()).toBe("warning: something degraded but not fatal");
});

test("warn writes to stderr, never stdout", () => {
  const io = testIO();
  warn(io.io, "keep stdout clean");
  expect(io.stdout()).toBe("");
});
