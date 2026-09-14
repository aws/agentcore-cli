import { describe, expect, test } from "bun:test";
import { getDefaultMemorySpec, PROJECT_TEMPLATE_NAMES } from "./shortcuts";

describe("template order", () => {
  test("groups by protocol, then language, framework, and build, with empty last", () => {
    expect(PROJECT_TEMPLATE_NAMES).toEqual([
      "agent-python-strands",
      "agent-python-strands-container",
      "agent-python-langchain",
      "agent-python-minimal",
      "agent-typescript-strands",
      "agent-typescript-vercel",
      "a2a-python-strands",
      "agui-python-strands",
      "mcp-python-fastmcp",
      "empty",
    ]);
  });
});

test("default memory names fit the service limit for long runtime names", () => {
  const memory = getDefaultMemorySpec("a".repeat(48));

  expect(memory.name).toBe(`${"a".repeat(42)}Memory`);
  expect(memory.name).toHaveLength(48);
});
